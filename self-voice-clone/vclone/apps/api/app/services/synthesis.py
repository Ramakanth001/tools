import json
import multiprocessing as mp
import os
from pathlib import Path
from queue import Empty
import shutil
import signal
import subprocess
import time
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.generated_asset import GeneratedAsset
from app.models.synthesis_job import SynthesisJob
from app.models.voice_profile import VoiceProfile
from app.services.audio_quality import AudioQualityService
from app.services.audit import AuditService
from app.services.audio_artifacts import inspect_audio_artifact, validate_voxcpm_reference_audio
from app.services.asr_backcheck import ASRBackcheckService
from app.services.evaluation import EvaluationService
from app.services.engine_registry import EngineRegistry
from app.services.mastering import AudioMasteringService
from app.services.post_synthesis_qc import PostSynthesisQCService
from app.services.storage import StorageService
from app.services.text import chunk_text, chunk_text_for_clone, chunk_text_for_clone_plan, normalize_text, prepare_text_for_tts, split_for_regeneration
from app.services.tts_engine import XTTSInferenceError


class SynthesisCancelledError(RuntimeError):
    pass


_SMOKE_TEST_SENTENCE = "This is a complete smoke test sentence for checking whether the cloned voice can speak clearly without leaking prompt text."


def _prequalify_candidates(
    *,
    registry,
    candidate_plan: list[dict],
    voice_profile_id: str,
    mode: str,
    work_dir: Path,
    language: str | None,
    voice_profile_report: dict,
    asr_backcheck,
    candidate_gating,
    speaker_verification,
    similarity_trusted: bool,
) -> tuple[list[dict], list[dict]]:
    qualified: list[dict] = []
    failures: list[dict] = []
    smoke_dir = work_dir / "smoke"
    smoke_dir.mkdir(parents=True, exist_ok=True)

    for index, candidate in enumerate(candidate_plan, start=1):
        candidate_engine_name = str(candidate.get("engine_name") or "")
        try:
            validation = validate_voxcpm_reference_audio(
                str(candidate.get("speaker_wav") or ""),
                manifest=candidate,
                artifact_type="model_candidate",
                expected_duration_sec=candidate.get("expected_duration_sec"),
            )
            if not validation.valid:
                failures.append(
                    {
                        "engine_name": candidate_engine_name,
                        "label": candidate.get("label"),
                        "clone_mode": candidate.get("clone_mode"),
                        "error": validation.code,
                        "validation": validation.to_dict(),
                    }
                )
                continue
            engine = registry.get_engine_by_name(candidate_engine_name)
            smoke_path = smoke_dir / f"candidate-{index:02d}.wav"
            synthesis = engine.synthesize(
                _SMOKE_TEST_SENTENCE,
                str(voice_profile_id),
                str(mode),
                str(smoke_path),
                speaker_wav=str(candidate.get("speaker_wav") or ""),
                language=language,
                prompt_text=str(candidate.get("prompt_text") or ""),
                voice_profile_report=voice_profile_report,
                clone_mode=str(candidate.get("clone_mode") or "reference_only"),
            )
            backcheck = asr_backcheck.evaluate(
                expected_text=_SMOKE_TEST_SENTENCE,
                chunks=[_SMOKE_TEST_SENTENCE],
                audio_path=str(smoke_path),
            )
            similarity = speaker_verification.verify(
                reference_audio_path=str(candidate.get("speaker_wav") or ""),
                candidate_audio_path=str(smoke_path),
            )
            gate_result = candidate_gating.evaluate(
                mode=str(mode),
                target_text=_SMOKE_TEST_SENTENCE,
                observed_text=str(backcheck.get("observed_text") or ""),
                prompt_text=str(candidate.get("prompt_text") or ""),
                audio_path=str(smoke_path),
                backcheck=backcheck,
                similarity=similarity.to_dict(),
                similarity_trusted=similarity_trusted,
            )
            if gate_result.passed:
                qualified_candidate = dict(candidate)
                qualified_candidate["smoke_test"] = {
                    "status": "passed",
                    "gate_result": gate_result.to_dict(),
                    "backcheck": backcheck,
                    "similarity": similarity.to_dict(),
                    "synthesis": synthesis,
                }
                qualified.append(qualified_candidate)
            else:
                failed = {
                    "engine_name": candidate_engine_name,
                    "label": candidate.get("label"),
                    "clone_mode": candidate.get("clone_mode"),
                    "error": "smoke_test_failed_quality_gate",
                    "gate_result": gate_result.to_dict(),
                    "backcheck": backcheck,
                    "similarity": similarity.to_dict(),
                }
                failures.append(failed)
        except BaseException as exc:  # noqa: BLE001
            failures.append(
                {
                    "engine_name": candidate_engine_name,
                    "label": candidate.get("label"),
                    "clone_mode": candidate.get("clone_mode"),
                    "error": f"smoke_test_exception:{type(exc).__name__}: {exc}",
                }
            )
    return qualified, failures


def _synthesis_engine_worker(payload: dict, result_queue) -> None:
    from app.services.asr_backcheck import ASRBackcheckService
    from app.services.candidate_gating import CandidateGateService
    from app.services.engine_registry import EngineRegistry
    from app.services.speaker_verification import SpeakerVerificationService
    from app.services.similarity_calibration import SimilarityCalibrationService
    import shutil

    try:
        registry = EngineRegistry()
        chunk_paths: list[str] = []
        engine_runs: list[dict] = []
        candidate_selections: list[dict] = []
        chunk_texts: list[str] = list(payload.get("chunk_texts") or [])
        candidate_plan: list[dict] = list(payload.get("candidate_plan") or [])
        chunk_dir = Path(str(payload["chunk_dir"]))
        chunk_dir.mkdir(parents=True, exist_ok=True)
        asr_backcheck = ASRBackcheckService()
        candidate_gating = CandidateGateService()
        speaker_verification = SpeakerVerificationService()
        similarity_calibration = SimilarityCalibrationService().calibrate(golden_ref_path=str(payload["speaker_wav"]))
        qualified_candidates, smoke_failures = _prequalify_candidates(
            registry=registry,
            candidate_plan=candidate_plan,
            voice_profile_id=str(payload["voice_profile_id"]),
            mode=str(payload["mode"]),
            work_dir=chunk_dir,
            language=payload.get("language"),
            voice_profile_report=payload.get("voice_profile_report") or {},
            asr_backcheck=asr_backcheck,
            candidate_gating=candidate_gating,
            speaker_verification=speaker_verification,
            similarity_trusted=similarity_calibration.trusted,
        )
        if qualified_candidates:
            candidate_plan = qualified_candidates
        elif candidate_plan:
            raise RuntimeError(f"failed_profile_reference_invalid: {smoke_failures}")
        locked_candidate: dict | None = None
        for index, render_text in enumerate(chunk_texts, start=1):
            result_queue.put(
                {
                    "type": "progress",
                    "current_chunk": index,
                    "total_chunks": len(chunk_texts),
                }
            )
            final_chunk_path = chunk_dir / f"chunk-{index:03d}.wav"
            best_candidate: dict | None = None
            failed_candidates: list[dict] = []
            plan = ([locked_candidate] if locked_candidate else candidate_plan) or [
                {
                    "label": "default",
                    "speaker_wav": str(payload["speaker_wav"]),
                    "prompt_text": payload.get("prompt_text") or "",
                    "clone_mode": "reference_only",
                }
            ]
            for candidate_index, candidate in enumerate(plan, start=1):
                candidate_path = chunk_dir / f"chunk-{index:03d}-cand-{candidate_index:02d}.wav"
                candidate_engine_name = str(candidate.get("engine_name") or payload["engine_name"])
                try:
                    engine = registry.get_engine_by_name(candidate_engine_name)
                    synthesis = engine.synthesize(
                        render_text,
                        str(payload["voice_profile_id"]),
                        str(payload["mode"]),
                        str(candidate_path),
                        speaker_wav=str(candidate.get("speaker_wav") or payload["speaker_wav"]),
                        language=payload.get("language"),
                        prompt_text=str(candidate.get("prompt_text") or payload.get("prompt_text") or ""),
                        voice_profile_report=payload.get("voice_profile_report") or {},
                        clone_mode=str(candidate.get("clone_mode") or "reference_only"),
                    )
                    backcheck = asr_backcheck.evaluate(expected_text=render_text, chunks=[render_text], audio_path=str(candidate_path))
                    similarity = speaker_verification.verify(
                        reference_audio_path=str(candidate.get("speaker_wav") or payload["speaker_wav"]),
                        candidate_audio_path=str(candidate_path),
                    )
                    gate_result = candidate_gating.evaluate(
                        mode=str(payload["mode"]),
                        target_text=render_text,
                        observed_text=str(backcheck.get("observed_text") or ""),
                        prompt_text=str(candidate.get("prompt_text") or ""),
                        audio_path=str(candidate_path),
                        backcheck=backcheck,
                        similarity=similarity.to_dict(),
                        similarity_trusted=similarity_calibration.trusted,
                    )
                    if not gate_result.passed:
                        failed_candidates.append(
                            {
                                "engine_name": candidate_engine_name,
                                "label": candidate.get("label"),
                                "clone_mode": candidate.get("clone_mode"),
                                "error": "failed_quality_gate",
                                "gate_result": gate_result.to_dict(),
                            }
                        )
                        continue
                    candidate_result = {
                        "candidate": candidate,
                        "synthesis": synthesis,
                        "backcheck": backcheck,
                        "similarity": similarity.to_dict(),
                        "gate_result": gate_result.to_dict(),
                        "quality_score": gate_result.quality_score,
                        "error_cost": gate_result.error_cost,
                        "path": str(candidate_path),
                    }
                    if best_candidate is None or gate_result.quality_score > float(best_candidate["quality_score"]):
                        best_candidate = candidate_result
                except BaseException as exc:  # noqa: BLE001 - one candidate failing must not abort the whole job.
                    failed_candidates.append(
                        {
                            "engine_name": candidate_engine_name,
                            "label": candidate.get("label"),
                            "clone_mode": candidate.get("clone_mode"),
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )
                    continue

            if best_candidate is None:
                raise RuntimeError(f"All synthesis candidates failed: {failed_candidates}")

            if Path(best_candidate["path"]).resolve() != final_chunk_path.resolve():
                shutil.copyfile(best_candidate["path"], final_chunk_path)
            if locked_candidate is None:
                locked_candidate = dict(best_candidate["candidate"])
            best_synthesis = dict(best_candidate["synthesis"])
            best_synthesis["candidate_selection"] = {
                "engine_name": best_candidate["candidate"].get("engine_name") or payload["engine_name"],
                "label": best_candidate["candidate"].get("label"),
                "clone_mode": best_candidate["candidate"].get("clone_mode"),
                "quality_score": best_candidate["quality_score"],
                "error_cost": best_candidate["error_cost"],
                "score_direction": "higher_quality_score",
                "selected_reason": "highest valid quality_score after hard quality gates",
                "gate_result": best_candidate["gate_result"],
                "backcheck": best_candidate["backcheck"],
                "similarity": best_candidate["similarity"],
                "similarity_calibration": similarity_calibration.to_dict(),
                "smoke_test_failures": smoke_failures,
                "failed_candidates": failed_candidates,
                "global_prompt_locked": True,
            }
            chunk_paths.append(str(final_chunk_path))
            engine_runs.append(best_synthesis)
            candidate_selections.append(best_synthesis["candidate_selection"])
        result_queue.put(
            {
                "type": "done",
                "chunk_paths": chunk_paths,
                "engine_runs": engine_runs,
                "candidate_selections": candidate_selections,
                "qualified_candidates": candidate_plan,
                "smoke_test_failures": smoke_failures,
            }
        )
    except BaseException as exc:  # noqa: BLE001 - worker must report all failures to parent when possible.
        result_queue.put({"type": "error", "error": f"{type(exc).__name__}: {exc}"})


def _synthesis_single_chunk_worker(payload: dict, result_queue) -> None:
    from app.core.config import get_settings
    from app.services.asr_backcheck import ASRBackcheckService
    from app.services.candidate_gating import CandidateGateService
    from app.services.engine_registry import EngineRegistry
    from app.services.similarity_calibration import SimilarityCalibrationService
    from app.services.speaker_verification import SpeakerVerificationService

    try:
        settings = get_settings()
        registry = EngineRegistry()
        engine = registry.get_engine_by_name(str(payload["engine_name"]))
        candidate = dict(payload.get("candidate") or {})
        output_path = Path(str(payload["output_path"]))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        reference_path = str(candidate.get("speaker_wav") or payload["speaker_wav"])
        prompt_text = str(candidate.get("prompt_text") or payload.get("prompt_text") or "")
        target_text = str(payload["text"])
        attempt_limit = max(1, min(3, int(payload.get("attempt_count") or settings.synthesis_candidate_attempts)))
        asr_backcheck = ASRBackcheckService()
        candidate_gating = CandidateGateService()
        speaker_verification = SpeakerVerificationService(threshold=float(settings.synthesis_min_speaker_similarity))
        similarity_calibration = SimilarityCalibrationService().calibrate(golden_ref_path=reference_path)
        attempts: list[dict] = []

        for attempt_index in range(1, attempt_limit + 1):
            attempt_path = output_path.with_name(f"{output_path.stem}.attempt-{attempt_index:02d}{output_path.suffix}")
            synthesis = engine.synthesize(
                target_text,
                str(payload["voice_profile_id"]),
                str(payload["mode"]),
                str(attempt_path),
                speaker_wav=reference_path,
                language=payload.get("language"),
                prompt_text=prompt_text,
                voice_profile_report=payload.get("voice_profile_report") or {},
                clone_mode=str(candidate.get("clone_mode") or "reference_only"),
            )
            backcheck = asr_backcheck.evaluate(expected_text=target_text, chunks=[target_text], audio_path=str(attempt_path))
            similarity = speaker_verification.verify(reference_audio_path=reference_path, candidate_audio_path=str(attempt_path))
            gate_result = candidate_gating.evaluate(
                mode=str(payload["mode"]),
                target_text=target_text,
                observed_text=str(backcheck.get("observed_text") or ""),
                prompt_text=prompt_text,
                audio_path=str(attempt_path),
                backcheck=backcheck,
                similarity=similarity.to_dict(),
                similarity_trusted=similarity_calibration.trusted,
            )
            attempts.append(
                {
                    "attempt": attempt_index,
                    "path": str(attempt_path),
                    "synthesis": synthesis,
                    "backcheck": backcheck,
                    "similarity": similarity.to_dict(),
                    "gate_result": gate_result.to_dict(),
                }
            )
            if gate_result.passed and (
                not similarity_calibration.trusted
                or similarity.similarity_score >= float(settings.synthesis_identity_early_stop)
            ):
                break

        verified_attempts = [item for item in attempts if bool((item.get("gate_result") or {}).get("passed"))]
        if not verified_attempts:
            summary = [
                {
                    "attempt": item.get("attempt"),
                    "speaker_similarity": (item.get("similarity") or {}).get("similarity_score"),
                    "wer": (item.get("backcheck") or {}).get("estimated_wer"),
                    "reasons": (item.get("gate_result") or {}).get("hard_reasons", []),
                }
                for item in attempts
            ]
            raise RuntimeError(f"failed_voice_identity_gate: no generated take matched the enrolled speaker: {summary}")

        best = max(
            verified_attempts,
            key=lambda item: (
                float((item.get("similarity") or {}).get("similarity_score") or -1.0),
                float((item.get("gate_result") or {}).get("quality_score") or 0.0),
            ),
        )
        if Path(str(best["path"])).resolve() != output_path.resolve():
            shutil.copyfile(str(best["path"]), output_path)
        synthesis = dict(best.get("synthesis") or {})
        synthesis["clone_verification"] = {
            "status": "verified",
            "selected_attempt": best.get("attempt"),
            "attempt_count": len(attempts),
            "backcheck": best.get("backcheck"),
            "similarity": best.get("similarity"),
            "gate_result": best.get("gate_result"),
            "similarity_calibration": similarity_calibration.to_dict(),
            "attempts": attempts,
        }
        result_queue.put({"type": "done", "output_path": str(output_path), "synthesis": synthesis})
    except BaseException as exc:  # noqa: BLE001 - worker must report all failures to parent when possible.
        result_queue.put({"type": "error", "error": f"{type(exc).__name__}: {exc}"})


class SynthesisService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = AuditService(db)
        self.storage = StorageService()
        self.engine_registry = EngineRegistry()
        self.mastering = AudioMasteringService()
        self.audio_quality = AudioQualityService()
        self.post_qc = PostSynthesisQCService()
        self.asr_backcheck = ASRBackcheckService()
        self.evaluation = EvaluationService()
        self.settings = get_settings()

    def create_job(
        self,
        voice_profile_id: str,
        text: str,
        mode: str,
        format: str,
        sample_rate_hz: int,
        locale: str,
        channels: int = 2,
        require_native_master: bool = False,
    ) -> SynthesisJob:
        profile = self.db.get(VoiceProfile, voice_profile_id)
        if profile is None:
            raise ValueError("Voice profile not found")
        if profile.status not in {"ready", "ready_with_warning"}:
            raise ValueError(
                f"Voice profile is not ready for clone inference yet (status={profile.status}). "
                "Re-run enrollment/retry processing so the profile has curated clone prompt artifacts."
            )
        profile_report = self._profile_report(profile)
        reference_path, prompt_text = self._resolve_clone_reference(profile, profile_report)
        if not reference_path or not Path(reference_path).exists():
            raise ValueError("Voice profile clone prompt/reference audio is missing. Re-run enrollment processing from the original upload.")

        delivery_request = self.mastering.normalize_delivery_request(format, sample_rate_hz, channels)
        engine_selection = self.engine_registry.select(
            mode,
            sample_rate_hz=int(delivery_request["sample_rate_hz"]),
            channels=int(delivery_request["channels"]),
        )
        engine = engine_selection["engine"]
        if not engine_selection["capabilities"].get("runtime", {}).get("available"):
            reason = engine_selection["capabilities"].get("runtime", {}).get("reason", "Selected clone engine is unavailable.")
            raise ValueError(f"Selected clone engine '{engine.name}' is unavailable. {reason}")
        pronunciation_profile = profile_report.get("pronunciation_profile") or {}
        prepared_text = prepare_text_for_tts(text, pronunciation_profile=pronunciation_profile)
        normalized = prepared_text.synthesis_text
        chunk_plan = chunk_text_for_clone_plan(normalized, mode=mode, max_chars=self.settings.synthesis_max_chunk_chars)
        if len(chunk_plan) >= int(self.settings.synthesis_long_text_chunk_threshold):
            chunk_plan = chunk_text_for_clone_plan(normalized, mode=mode, max_chars=int(self.settings.synthesis_long_text_chunk_chars))
        chunks = [str(item.get("text") or "").strip() for item in chunk_plan if str(item.get("text") or "").strip()]
        chunk_join_hints = [str(item.get("break_after") or "sentence") for item in chunk_plan if str(item.get("text") or "").strip()]
        if not chunks:
            raise ValueError("Text to synthesize is empty after normalization")
        long_form_synthesis = len(chunks) >= int(self.settings.synthesis_long_text_chunk_threshold)
        qc_plan = self.post_qc.evaluate_chunks(chunks)
        regeneration_plan = self.post_qc.regeneration_plan(chunks, qc_plan)
        if mode == "final" and self._strict_native_master_required(require_native_master):
            if int(delivery_request["sample_rate_hz"]) > engine.native_sample_rate_hz or int(delivery_request["channels"]) > engine.native_channels:
                raise ValueError(
                    "Requested final delivery would be derived rather than native. Lower the requested delivery spec, switch to preview/mono 24 kHz, or integrate a native final-render engine."
                )

        candidate_plan = self._build_candidate_plan(engine.name, profile_report, reference_path, prompt_text, mode)
        if long_form_synthesis and engine.name == "voxcpm2":
            candidate_plan = candidate_plan[: max(1, int(self.settings.synthesis_long_text_candidate_limit))]
        elif engine.name == "voxcpm2" and not bool(self.settings.synthesis_enable_smoke_tests):
            candidate_plan = candidate_plan[:1]

        job = SynthesisJob(
            user_id=profile.user_id,
            voice_profile_id=voice_profile_id,
            mode=mode,
            status="queued",
            request_json=json.dumps(
                {
                    "text": text,
                    "original_text": prepared_text.original_text,
                    "normalized_text": prepared_text.normalized_text,
                    "synthesis_text": prepared_text.synthesis_text,
                    "text_preparation": prepared_text.to_dict(),
                    "pronunciation_profile_applied": bool((pronunciation_profile or {}).get("lexicon")),
                    "pronunciation_profile": pronunciation_profile,
                    "format": delivery_request["format"],
                    "sample_rate_hz": delivery_request["sample_rate_hz"],
                    "channels": delivery_request["channels"],
                    "locale": locale,
                    "require_native_master": require_native_master,
                    "engine": engine_selection["capabilities"],
                    "engine_registry": self.engine_registry.describe(),
                    "clone_reference_audio_path": reference_path,
                    "clone_prompt_text_available": bool(prompt_text),
                    "clone_dataset_status": profile_report.get("clone_dataset", {}).get("status"),
                    "engine_warnings": engine_selection["warnings"],
                    "engine_selection_reason": engine_selection["selection_reason"],
                    "engine_selection_rationale": engine_selection["rationale"],
                    "preflight_qc": qc_plan,
                    "regeneration_plan": regeneration_plan,
                    "candidate_plan": candidate_plan,
                    "chunk_join_hints": chunk_join_hints,
                    "long_form_synthesis": long_form_synthesis,
                    "queued_at": self._now_iso(),
                    "synthesis_started_at": None,
                    "synthesis_completed_at": None,
                    "synthesis_elapsed_seconds": None,
                    "cancel_requested": False,
                    "last_heartbeat_at": self._now_iso(),
                    "worker_started_at": None,
                    "worker_pid": None,
                }
            ),
            normalized_text=normalized,
            output_text_chunks=json.dumps(chunks),
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def _update_job_progress(
        self,
        job: SynthesisJob,
        *,
        stage: str,
        percent: int,
        message: str,
        current_chunk: int = 0,
        total_chunks: int = 0,
        worker_pid: int | None = None,
        worker_started_at: str | None = None,
    ) -> None:
        request = json.loads(job.request_json or "{}")
        request["progress"] = {
            "stage": stage,
            "percent": max(0, min(100, int(percent))),
            "message": message,
            "current_chunk": current_chunk,
            "total_chunks": total_chunks,
        }
        request["last_heartbeat_at"] = self._now_iso()
        if worker_pid is not None:
            request["worker_pid"] = worker_pid
        if worker_started_at is not None:
            request["worker_started_at"] = worker_started_at
        job.request_json = json.dumps(request)
        self.db.add(job)
        self.db.commit()

    def run_job(self, job_id: str) -> SynthesisJob:
        job = self.db.get(SynthesisJob, job_id)
        if job is None:
            raise ValueError("Synthesis job not found")
        profile = self.db.get(VoiceProfile, job.voice_profile_id)
        if profile is None:
            job.status = "failed"
            self.db.add(job)
            self.db.commit()
            raise ValueError("Voice profile not found")

        request = json.loads(job.request_json or "{}")
        if not request.get("synthesis_started_at"):
            request["synthesis_started_at"] = self._now_iso()
        request["synthesis_completed_at"] = None
        request["synthesis_elapsed_seconds"] = None
        job.request_json = json.dumps(request)
        profile_report = self._profile_report(profile)
        reference_path, prompt_text = self._resolve_clone_reference(profile, profile_report)
        chunks = json.loads(job.output_text_chunks or "[]")
        if not chunks:
            job.status = "failed"
            self.db.add(job)
            self.db.commit()
            raise ValueError("Synthesis job has no text chunks")

        delivery_request = self.mastering.normalize_delivery_request(
            str(request.get("format", "wav")),
            int(request.get("sample_rate_hz", 24000)),
            int(request.get("channels", 1)),
        )
        engine_selection = self.engine_registry.select(
            job.mode,
            sample_rate_hz=int(delivery_request["sample_rate_hz"]),
            channels=int(delivery_request["channels"]),
        )
        engine = engine_selection["engine"]
        qc_plan = request.get("preflight_qc", {})
        regeneration_plan = request.get("regeneration_plan", {})
        normalized = job.normalized_text
        locale = str(request.get("locale", self.settings.xtts_default_language))
        require_native_master = bool(request.get("require_native_master", False))
        chunk_join_hints = list(request.get("chunk_join_hints") or [])

        output_dir = Path("uploads") / profile.user_id / "generated" / job.id
        output_dir.mkdir(parents=True, exist_ok=True)
        chunk_dir = output_dir / "chunks"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        native_mix_path = output_dir / "native-mix.wav"
        synthesis_manifest_path = output_dir / "manifest.json"
        output_path = output_dir / f"output.{delivery_request['format']}"

        job.status = "running"
        self.db.add(job)
        self.db.commit()
        self._update_job_progress(job, stage="running", percent=5, message="Synthesis job started.", total_chunks=len(chunks))

        try:
            language_code = (locale or self.settings.xtts_default_language).split("-")[0].lower()
            render_chunks: list[str] = []
            for index, chunk in enumerate(chunks, start=1):
                render_text = chunk
                if index in qc_plan.get("failed_segments", []):
                    split_version = split_for_regeneration(chunk)
                    render_text = " ".join(split_version)
                render_chunks.append(render_text)

            isolated = self._run_isolated_engine_job(
                job=job,
                engine_name=engine.name,
                chunk_texts=render_chunks,
                chunk_dir=str(chunk_dir),
                speaker_wav=reference_path,
                language=language_code,
                prompt_text=prompt_text,
                voice_profile_report=profile_report,
                candidate_plan=list(request.get("candidate_plan") or []),
            )
            chunk_paths = self._apply_inter_chunk_pauses(isolated["chunk_paths"], chunks, chunk_join_hints=chunk_join_hints)
            engine_runs = isolated["engine_runs"]
            candidate_selections = isolated.get("candidate_selections", [])
            qualified_candidates = isolated.get("qualified_candidates", [])
            smoke_test_failures = isolated.get("smoke_test_failures", [])
            failed_chunks = isolated.get("failed_chunks", [])
            partial_output = bool(isolated.get("partial", False))
            progress_manifest_path = isolated.get("progress_manifest_path")

            self._update_job_progress(job, stage="mastering", percent=80, message="Concatenating and mastering generated chunks.")
            concat_info = self.mastering.concatenate_wav_chunks(chunk_paths, str(native_mix_path))
            delivery_report = self.mastering.master_audio(
                str(native_mix_path),
                str(output_path),
                audio_format=str(delivery_request["format"]),
                sample_rate_hz=int(delivery_request["sample_rate_hz"]),
                channels=int(delivery_request["channels"]),
            )
            source_quality = self.audio_quality.inspect(reference_path, context="source")
            native_quality = self.audio_quality.inspect(str(native_mix_path), context="generated", target_text=normalized)
            delivery_quality = self.audio_quality.inspect(str(output_path), context="generated", target_text=normalized)
            audio_quality_payload = self._audio_quality_payload(
                source_quality=source_quality,
                generated_quality=native_quality,
                delivery_quality=delivery_quality,
            )
            # Keep generated-audio quality findings advisory. The user asked for synthesis
            # to complete whenever the engine produced a readable file; reports should
            # inform review/regeneration, not introduce new hard failures.

            if job.mode == "preview":
                asr_backcheck = {
                    "status": "measured_by_candidate_gate",
                    "reason": "Clone preview uses per-candidate ASR gates before selecting output.",
                    "candidate_selections": candidate_selections,
                    "failed_chunks": failed_chunks,
                    "partial_output": partial_output,
                    "progress_manifest_path": progress_manifest_path,
                }
                evaluation_payload = {
                    "status": "measured_by_candidate_gate",
                    "reason": "Clone preview uses prompt-leak, WER, script, duration, repetition, and similarity gates.",
                    "candidate_selections": candidate_selections,
                    "failed_chunks": failed_chunks,
                    "partial_output": partial_output,
                    "progress_manifest_path": progress_manifest_path,
                }
            else:
                self._update_job_progress(job, stage="evaluation", percent=90, message="Running final ASR/evaluation checks.")
                asr_backcheck = self.asr_backcheck.evaluate(expected_text=normalized, chunks=chunks, audio_path=str(output_path))
                evaluation_report = self.evaluation.evaluate(
                    audio_path=str(output_path),
                    reference_path=reference_path,
                    expected_text=normalized,
                    chunks=chunks,
                )
                evaluation_payload = evaluation_report.to_dict()
        except SynthesisCancelledError as exc:
            job.status = "cancelled"
            self._mark_job_timing_completed(job)
            self._update_job_progress(job, stage="cancelled", percent=100, message=str(exc))
            self.db.add(job)
            self.db.commit()
            return job
        except XTTSInferenceError as exc:
            job.status = "failed"
            self._mark_job_timing_completed(job)
            self._update_job_progress(job, stage="failed", percent=100, message=str(exc))
            self.db.add(job)
            self.db.commit()
            return job
        except Exception as exc:
            job.status = "failed"
            self._mark_job_timing_completed(job)
            self._update_job_progress(job, stage="failed", percent=100, message=f"Synthesis failed: {exc}")
            self.db.add(job)
            self.db.commit()
            return job

        self._mark_job_timing_completed(job)
        request = json.loads(job.request_json or "{}")

        asset = GeneratedAsset(
            synthesis_job_id=job.id,
            format=str(delivery_request["format"]),
            sample_rate=delivery_report["delivery"]["sample_rate_hz"],
            channels=delivery_report["delivery"]["channels"],
            duration_ms=delivery_report["delivery"]["duration_ms"],
            object_key=str(output_path),
            watermark_info_json=json.dumps(
                {
                    "provenance": "curated-clone-profile-v1",
                    "engine": engine_runs[0]["engine"] if engine_runs else engine.name,
                    "device": engine_runs[0].get("device") if engine_runs else None,
                    "language": engine_runs[0].get("language") if engine_runs else None,
                    "chunk_count": len(chunks),
                    "qc": qc_plan,
                    "regeneration_plan": regeneration_plan,
                    "asr_backcheck": asr_backcheck,
                    "evaluation": evaluation_payload,
                    "concat": concat_info,
                    "candidate_plan": request.get("candidate_plan", []),
                    "qualified_candidates": qualified_candidates,
                    "smoke_test_failures": smoke_test_failures,
                    "candidate_selections": candidate_selections,
                    "failed_chunks": failed_chunks,
                    "partial_output": partial_output,
                    "progress_manifest_path": progress_manifest_path,
                    "synthesis_started_at": request.get("synthesis_started_at"),
                    "synthesis_completed_at": request.get("synthesis_completed_at"),
                    "synthesis_elapsed_seconds": request.get("synthesis_elapsed_seconds"),
                    "clone_profile": {
                        "dataset_status": profile_report.get("clone_dataset", {}).get("status"),
                        "curated_minutes": profile_report.get("clone_dataset", {}).get("curated_minutes"),
                        "reference_audio_path": reference_path,
                        "prompt_text_used": bool(prompt_text),
                    },
                    "engine_selection": {
                        "requested_mode": job.mode,
                        "resolved_engine": engine_selection["capabilities"],
                        "selection_reason": engine_selection["selection_reason"],
                        "rationale": engine_selection["rationale"],
                        "warnings": engine_selection["warnings"],
                    },
                    "engine_registry": self.engine_registry.describe(),
                    "delivery_report": delivery_report,
                    "audio_quality": audio_quality_payload,
                }
            ),
            checksum_sha256=delivery_report["delivery"]["checksum_sha256"],
        )

        synthesis_manifest = {
            "job_id": job.id,
            "voice_profile_id": job.voice_profile_id,
            "engine_name": engine.name,
            "mode": job.mode,
            "locale": locale,
            "normalized_text": normalized,
            "chunks": chunks,
            "candidate_plan": request.get("candidate_plan", []),
            "qualified_candidates": qualified_candidates,
            "smoke_test_failures": smoke_test_failures,
            "candidate_selections": candidate_selections,
            "failed_chunks": failed_chunks,
            "partial_output": partial_output,
            "progress_manifest_path": progress_manifest_path,
            "synthesis_started_at": request.get("synthesis_started_at"),
            "synthesis_completed_at": request.get("synthesis_completed_at"),
            "synthesis_elapsed_seconds": request.get("synthesis_elapsed_seconds"),
            "chunk_paths": chunk_paths,
            "reference_path": reference_path,
            "prompt_text": prompt_text,
            "output_path": str(output_path),
            "audio_quality": audio_quality_payload,
        }
        synthesis_manifest_path.write_text(json.dumps(synthesis_manifest, indent=2), encoding="utf-8")

        if require_native_master and not delivery_report["spotify"]["native_master_ok"]:
            request["native_master_warning"] = self._native_master_warning_payload(delivery_report)
            job.request_json = json.dumps(request)

        if self._selected_candidate_failed_gate(candidate_selections):
            job.status = "failed_quality_gate"
            self._mark_job_timing_completed(job)
            self._update_job_progress(job, stage="failed_quality_gate", percent=100, message="Selected candidate failed clone quality gate.")
            self.db.add(job)
            self.db.commit()
            return job

        self.db.add(asset)
        job.status = "completed_partial" if partial_output else "completed"
        self._update_job_progress(
            job,
            stage=job.status,
            percent=100,
            message="Synthesis produced partial audio. Retry to resume missing chunks." if partial_output else "Synthesis completed. Download is ready.",
        )
        self.db.add(job)
        self.db.commit()
        self.audit.log(actor_user_id=profile.user_id, action="synthesis.created", target_type="synthesis_job", target_id=job.id)
        return job

    def get_job(self, job_id: str) -> SynthesisJob | None:
        return self.db.get(SynthesisJob, job_id)

    def get_preview(self, job_id: str) -> dict:
        job = self.db.get(SynthesisJob, job_id)
        if job is None:
            raise ValueError("Synthesis job not found")
        try:
            self._mark_stale_if_needed(job)
        except Exception:
            # Preview/status should never 500 because stale checking failed.
            pass
        self.db.refresh(job)
        return {
            "job_id": job.id,
            "status": job.status,
            "preview_text": job.normalized_text,
            "chunks": json.loads(job.output_text_chunks),
            "request": json.loads(job.request_json),
            "created_at": self._iso_datetime(getattr(job, "created_at", None)),
            "updated_at": self._iso_datetime(getattr(job, "updated_at", None)),
            "synthesis_started_at": (json.loads(job.request_json or "{}")).get("synthesis_started_at"),
            "synthesis_completed_at": (json.loads(job.request_json or "{}")).get("synthesis_completed_at"),
            "synthesis_elapsed_seconds": (json.loads(job.request_json or "{}")).get("synthesis_elapsed_seconds"),
        }

    def cancel_job(self, job_id: str) -> SynthesisJob:
        job = self.db.get(SynthesisJob, job_id)
        if job is None:
            raise ValueError("Synthesis job not found")
        request = json.loads(job.request_json or "{}")
        request["cancel_requested"] = True
        request["last_heartbeat_at"] = self._now_iso()
        worker_pid = int(request.get("worker_pid") or 0)
        if worker_pid > 0:
            self._terminate_pid(worker_pid)
        request["progress"] = {
            "stage": "cancel_requested",
            "percent": int((request.get("progress") or {}).get("percent", 0) or 0),
            "message": "Cancellation requested. The synthesis worker will stop at the next safe checkpoint.",
            "current_chunk": int((request.get("progress") or {}).get("current_chunk", 0) or 0),
            "total_chunks": int((request.get("progress") or {}).get("total_chunks", 0) or 0),
        }
        job.request_json = json.dumps(request)
        if job.status in {"queued", "running"}:
            job.status = "cancel_requested"
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def _terminate_pid(self, pid: int) -> None:
        if pid <= 0:
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except Exception:
            return
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except Exception:
            return
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass

    def get_download_url(self, job_id: str) -> dict:
        asset = self.db.query(GeneratedAsset).filter(GeneratedAsset.synthesis_job_id == job_id).one_or_none()
        if asset is None:
            raise ValueError("Generated asset not found")
        metadata = json.loads(asset.watermark_info_json or "{}")
        return {
            "url": f"/v1/synthesis/{job_id}/file",
            "expires_in_seconds": self.settings.signed_url_ttl_seconds,
            "asset": {
                "format": asset.format,
                "sample_rate_hz": asset.sample_rate,
                "channels": asset.channels,
                "duration_ms": asset.duration_ms,
                "local_path": asset.object_key,
                "checksum_sha256": asset.checksum_sha256,
            },
            "delivery_report": metadata.get("delivery_report", {}),
            "audio_quality": metadata.get("audio_quality", {}),
            "evaluation": metadata.get("evaluation", {}),
            "asr_backcheck": metadata.get("asr_backcheck", {}),
            "clone_profile": metadata.get("clone_profile", {}),
            "candidate_plan": metadata.get("candidate_plan", []),
            "qualified_candidates": metadata.get("qualified_candidates", []),
            "smoke_test_failures": metadata.get("smoke_test_failures", []),
            "candidate_selections": metadata.get("candidate_selections", []),
            "failed_chunks": metadata.get("failed_chunks", []),
            "partial_output": bool(metadata.get("partial_output", False)),
            "progress_manifest_path": metadata.get("progress_manifest_path"),
            "synthesis_started_at": metadata.get("synthesis_started_at"),
            "synthesis_completed_at": metadata.get("synthesis_completed_at"),
            "synthesis_elapsed_seconds": metadata.get("synthesis_elapsed_seconds"),
            "engine_selection": metadata.get("engine_selection", {}),
            "engine_registry": metadata.get("engine_registry", self.engine_registry.describe()),
        }

    def get_generated_file_path(self, job_id: str) -> str:
        asset = self.db.query(GeneratedAsset).filter(GeneratedAsset.synthesis_job_id == job_id).one_or_none()
        if asset is None:
            raise ValueError("Generated asset not found")
        path = Path(asset.object_key)
        if not path.exists() or not path.is_file():
            raise ValueError("Generated audio file not found on disk")
        return str(path)

    def _profile_report(self, profile: VoiceProfile) -> dict:
        try:
            return json.loads(profile.readiness_report_json or "{}")
        except json.JSONDecodeError:
            return {}

    def _prefer_existing_path(self, *candidates: object) -> str:
        normalized: list[str] = []
        for candidate in candidates:
            value = str(candidate or "").strip()
            if not value:
                continue
            normalized.append(value)
            if Path(value).exists():
                return value
        return normalized[0] if normalized else ""

    def _preferred_candidate_audio_path(self, candidate: dict, fallback_reference_path: str) -> str:
        return self._prefer_existing_path(
            candidate.get("audio_path"),
            candidate.get("audio_path_16k"),
            fallback_reference_path,
        )

    def _resolve_clone_reference(self, profile: VoiceProfile, profile_report: dict) -> tuple[str, str]:
        prompt = profile_report.get("clone_dataset", {}).get("prompt", {})
        reference_path = self._prefer_existing_path(
            prompt.get("golden_ref_audio_path"),
            prompt.get("golden_ref_audio_path_16k"),
            prompt.get("prompt_audio_path"),
            prompt.get("prompt_audio_path_16k"),
            prompt.get("single_prompt_audio_path"),
            prompt.get("single_prompt_audio_path_16k"),
            profile.sample_audio_path,
        )
        prompt_text = str(prompt.get("golden_ref_text") or prompt.get("prompt_text") or "").strip()
        reference_path = str(reference_path or "")
        if reference_path and Path(reference_path).exists():
            validation = validate_voxcpm_reference_audio(reference_path, artifact_type="model_candidate")
            if validation.valid:
                return reference_path, prompt_text
            fallback_reference = self._build_synthesis_reference_slice(profile, profile_report, reference_path)
            if fallback_reference:
                return fallback_reference, prompt_text
        return reference_path, prompt_text

    def _build_synthesis_reference_slice(self, profile: VoiceProfile, profile_report: dict, current_reference_path: str) -> str:
        source_candidates = [
            profile_report.get("curation", {}).get("curated_audio_path"),
            profile_report.get("clone_dataset", {}).get("prompt", {}).get("prompt_pack_audio_path"),
            profile_report.get("clone_dataset", {}).get("processed_audio_path"),
            profile_report.get("audio_processing", {}).get("processing_audio_path"),
            profile_report.get("audio_processing", {}).get("conditioning_audio_path"),
            profile_report.get("clone_dataset", {}).get("source_audio_path"),
            getattr(profile, "source_audio_path", ""),
            getattr(profile, "sample_audio_path", ""),
        ]
        out_dir = Path(current_reference_path).parent if current_reference_path else Path("uploads")
        out_dir.mkdir(parents=True, exist_ok=True)
        output = out_dir / "synthesis_fallback_ref.wav"
        target_seconds = min(
            float(self.settings.voice_prompt_max_seconds),
            max(float(self.settings.voice_prompt_target_seconds), float(self.settings.voice_prompt_min_seconds)),
        )
        for raw_source in source_candidates:
            source_value = str(raw_source or "").strip()
            if not source_value:
                continue
            source = Path(source_value)
            if not source.exists() or not source.is_file():
                continue
            source_validation = validate_voxcpm_reference_audio(source, artifact_type="model_candidate")
            if source_validation.valid:
                return str(source)
            source_duration = source_validation.stats.duration_sec or 0.0
            if source_duration < float(self.settings.voice_prompt_min_seconds):
                continue
            ffmpeg = shutil.which("ffmpeg")
            if ffmpeg:
                result = subprocess.run(
                    [ffmpeg, "-y", "-i", str(source), "-t", f"{target_seconds:.3f}", "-ar", "24000", "-ac", "1", str(output)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if result.returncode == 0 and output.exists() and output.stat().st_size > 44:
                    validation = validate_voxcpm_reference_audio(output, artifact_type="model_candidate")
                    if validation.valid:
                        return str(output)
            elif source_duration <= float(self.settings.voice_prompt_max_seconds):
                shutil.copyfile(source, output)
                validation = validate_voxcpm_reference_audio(output, artifact_type="model_candidate")
                if validation.valid:
                    return str(output)
        return ""

    def _build_candidate_plan(self, engine_name: str, profile_report: dict, reference_path: str, prompt_text: str, mode: str) -> list[dict]:
        prompt_bundle = profile_report.get("clone_dataset", {}).get("prompt", {})
        prompt_candidates = list(prompt_bundle.get("candidate_prompts") or [])
        if not prompt_candidates:
            prompt_candidates = [
                {
                    "rank": 1,
                    "audio_path": reference_path,
                    "audio_path_16k": reference_path,
                    "text": prompt_text,
                    "safe_for_prompt": True,
                }
            ]

        candidate_limit = int(
            self.settings.synthesis_preview_candidate_limit
            if mode == "preview"
            else self.settings.synthesis_final_candidate_limit
        )
        selected_candidates = prompt_candidates[: max(candidate_limit, 1)]
        plan: list[dict] = []

        if engine_name == "voxcpm2":
            first = selected_candidates[0] if selected_candidates else None
            ultimate_enabled = bool(getattr(self.settings, "voxcpm_enable_ultimate", True))
            if ultimate_enabled and first and first.get("text") and not bool(first.get("hifi_leak_failed")):
                plan.append(
                    {
                        "engine_name": "voxcpm2",
                        "label": "ultimate-prompt-1",
                        "speaker_wav": self._preferred_candidate_audio_path(first, reference_path),
                        "prompt_text": first.get("text") or prompt_text,
                        "clone_mode": "ultimate",
                        "safe_for_prompt": bool(first.get("safe_for_prompt", True)),
                        "expected_duration_sec": first.get("expected_duration_sec") or first.get("duration_seconds"),
                        "asr_wer": first.get("asr_wer"),
                        "asr_confidence": first.get("asr_confidence"),
                    }
                )
            for candidate in selected_candidates:
                plan.append(
                    {
                        "engine_name": "voxcpm2",
                        "label": f"ref-only-prompt-{candidate.get('rank', len(plan) + 1)}",
                        "speaker_wav": self._preferred_candidate_audio_path(candidate, reference_path),
                        "prompt_text": "",
                        "clone_mode": "reference_only",
                        "safe_for_prompt": bool(candidate.get("safe_for_prompt", True)),
                        "expected_duration_sec": candidate.get("expected_duration_sec") or candidate.get("duration_seconds"),
                        "actual_duration_sec": candidate.get("actual_duration_sec") or candidate.get("duration_seconds"),
                        "sample_rate": candidate.get("sample_rate"),
                        "channels": candidate.get("channels"),
                        "frames": candidate.get("frames"),
                        "non_silent_duration_sec": candidate.get("non_silent_duration_sec"),
                        "manifest_path": candidate.get("manifest_path"),
                    }
                )
            chatterbox_engine = self.engine_registry.get_engine_by_name("chatterbox")
            if mode == "preview" and self.settings.synthesis_enable_chatterbox_bakeoff and chatterbox_engine.runtime_status().get("available"):
                for candidate in selected_candidates[:2]:
                    plan.append(
                        {
                            "engine_name": "chatterbox",
                            "label": f"chatterbox-prompt-{candidate.get('rank', len(plan) + 1)}",
                            "speaker_wav": self._preferred_candidate_audio_path(candidate, reference_path),
                            "prompt_text": "",
                            "clone_mode": "prompt_clone",
                        }
                    )
        elif engine_name == "chatterbox":
            for candidate in selected_candidates:
                plan.append(
                    {
                        "engine_name": "chatterbox",
                        "label": f"prompt-clone-{candidate.get('rank', len(plan) + 1)}",
                        "speaker_wav": self._preferred_candidate_audio_path(candidate, reference_path),
                        "prompt_text": "",
                        "clone_mode": "prompt_clone",
                    }
                )
        else:
            plan.append(
                {
                    "engine_name": engine_name,
                    "label": "default",
                    "speaker_wav": reference_path,
                    "prompt_text": prompt_text,
                    "clone_mode": "reference_only",
                }
            )

        deduped: list[dict] = []
        seen: set[tuple[str, str, str, str]] = set()
        for item in plan:
            key = (
                str(item.get("engine_name") or ""),
                str(item.get("speaker_wav") or ""),
                str(item.get("prompt_text") or ""),
                str(item.get("clone_mode") or ""),
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped

    def _selected_candidate_failed_gate(self, selections: list[dict]) -> bool:
        for selection in selections:
            gate = selection.get("gate_result") or {}
            if gate and not bool(gate.get("passed")):
                return True
        return False

    def _strict_native_master_required(self, require_native_master: bool) -> bool:
        return bool(self.settings.fail_on_derived_final_master and require_native_master)

    def _native_master_warning_payload(self, delivery_report: dict) -> dict:
        return {
            "requested": True,
            "native_master_ok": bool((delivery_report.get("spotify") or {}).get("native_master_ok")),
            "status": (delivery_report.get("spotify") or {}).get("status"),
            "message": "Native master was requested, but the selected local clone engine produced a derived/packaged master. Audio is still exported for review.",
        }

    def _synthesis_progress_message(self, engine_name: str, index: int, total_chunks: int) -> str:
        if engine_name == "voxcpm2":
            return (
                f"Synthesizing chunk {index}/{total_chunks} with VoxCPM2. "
                "This is the primary clone model. A single global prompt candidate is locked for the whole job to prevent timbre drift."
            )
        if engine_name == "chatterbox":
            return f"Synthesizing chunk {index}/{total_chunks} with Chatterbox CPU/GPU prompt cloning."
        return f"Synthesizing chunk {index}/{total_chunks}."

    def _run_isolated_engine_job(
        self,
        *,
        job: SynthesisJob,
        engine_name: str,
        chunk_texts: list[str],
        chunk_dir: str,
        speaker_wav: str,
        language: str,
        prompt_text: str,
        voice_profile_report: dict,
        candidate_plan: list[dict],
    ) -> dict:
        ctx = mp.get_context("spawn")
        chunk_dir_path = Path(chunk_dir)
        chunk_dir_path.mkdir(parents=True, exist_ok=True)
        progress_path = chunk_dir_path / "progress.json"
        heartbeat_interval = max(1, int(self.settings.synthesis_heartbeat_interval_seconds))
        timeout_seconds = max(1, int(self.settings.synthesis_single_chunk_timeout_seconds))
        long_form = len(chunk_texts) >= int(self.settings.synthesis_long_text_chunk_threshold)

        def valid_existing_chunk(path: Path) -> bool:
            stats = inspect_audio_artifact(path)
            return bool(stats.exists and stats.readable and stats.frames and stats.frames > 0 and stats.duration_sec and stats.duration_sec > 0.2)

        def load_progress() -> dict:
            if not progress_path.exists():
                return {"job_id": job.id, "voice_profile_id": job.voice_profile_id, "engine_name": engine_name, "chunks": []}
            try:
                return json.loads(progress_path.read_text(encoding="utf-8"))
            except Exception:
                return {"job_id": job.id, "voice_profile_id": job.voice_profile_id, "engine_name": engine_name, "chunks": []}

        def save_progress(progress: dict) -> None:
            progress_path.write_text(json.dumps(progress, indent=2), encoding="utf-8")

        def upsert_chunk(progress: dict, payload: dict) -> None:
            rows = list(progress.get("chunks") or [])
            index = int(payload["index"])
            replaced = False
            for pos, row in enumerate(rows):
                if int(row.get("index") or 0) == index:
                    rows[pos] = {**row, **payload}
                    replaced = True
                    break
            if not replaced:
                rows.append(payload)
            progress["chunks"] = sorted(rows, key=lambda row: int(row.get("index") or 0))
            save_progress(progress)

        registry = EngineRegistry()
        asr_backcheck = ASRBackcheckService()
        candidate_gating = __import__("app.services.candidate_gating", fromlist=["CandidateGateService"]).CandidateGateService()
        speaker_verification = __import__("app.services.speaker_verification", fromlist=["SpeakerVerificationService"]).SpeakerVerificationService()
        similarity_calibration = __import__("app.services.similarity_calibration", fromlist=["SimilarityCalibrationService"]).SimilarityCalibrationService().calibrate(golden_ref_path=speaker_wav)
        candidate_plan = list(candidate_plan or [])
        if long_form and engine_name == "voxcpm2":
            candidate_plan = candidate_plan[: max(1, int(self.settings.synthesis_long_text_candidate_limit))]

        if long_form and candidate_plan:
            locked_candidate = dict(candidate_plan[0])
            validation = validate_voxcpm_reference_audio(
                str(locked_candidate.get("speaker_wav") or speaker_wav),
                manifest=locked_candidate,
                artifact_type="model_candidate",
                expected_duration_sec=locked_candidate.get("expected_duration_sec"),
            )
            if not validation.valid:
                raise XTTSInferenceError(f"Long-form reference candidate is invalid: {validation.message}")
            smoke_failures: list[dict] = []
            qualified_candidates = [locked_candidate]
        elif not bool(self.settings.synthesis_enable_smoke_tests):
            locked_candidate = dict((candidate_plan or [])[0]) if candidate_plan else {
                "engine_name": engine_name,
                "label": "default",
                "speaker_wav": speaker_wav,
                "prompt_text": prompt_text,
                "clone_mode": "reference_only",
            }
            validation = validate_voxcpm_reference_audio(
                str(locked_candidate.get("speaker_wav") or speaker_wav),
                manifest=locked_candidate,
                artifact_type="model_candidate",
                expected_duration_sec=locked_candidate.get("expected_duration_sec"),
            )
            if not validation.valid:
                raise XTTSInferenceError(f"Reference candidate is invalid: {validation.message}")
            smoke_failures = []
            qualified_candidates = [locked_candidate]
        else:
            candidate_plan = candidate_plan[: max(1, int(self.settings.synthesis_smoke_test_candidate_limit))]
            self._update_job_progress(
                job,
                stage="prequalifying_references",
                percent=8,
                message=f"Running optional smoke tests for {len(candidate_plan)} reference candidate(s).",
                total_chunks=len(chunk_texts),
            )
            qualified_candidates, smoke_failures = _prequalify_candidates(
                registry=registry,
                candidate_plan=candidate_plan,
                voice_profile_id=str(job.voice_profile_id),
                mode=str(job.mode),
                work_dir=chunk_dir_path,
                language=language,
                voice_profile_report=voice_profile_report,
                asr_backcheck=asr_backcheck,
                candidate_gating=candidate_gating,
                speaker_verification=speaker_verification,
                similarity_trusted=similarity_calibration.trusted,
            )
            if not qualified_candidates and candidate_plan:
                raise XTTSInferenceError(f"failed_profile_reference_invalid: {smoke_failures}")
            locked_candidate = dict(qualified_candidates[0]) if qualified_candidates else {
                "engine_name": engine_name,
                "label": "default",
                "speaker_wav": speaker_wav,
                "prompt_text": prompt_text,
                "clone_mode": "reference_only",
            }

        progress = load_progress()
        progress["locked_candidate"] = locked_candidate
        progress["total_chunks"] = len(chunk_texts)
        save_progress(progress)

        chunk_paths: list[str] = []
        engine_runs: list[dict] = []
        candidate_selections: list[dict] = []
        failed_chunks: list[dict] = []

        for index, render_text in enumerate(chunk_texts, start=1):
            final_chunk_path = chunk_dir_path / f"chunk-{index:03d}.wav"
            if bool(self.settings.synthesis_resume_existing_chunks) and valid_existing_chunk(final_chunk_path):
                chunk_paths.append(str(final_chunk_path))
                upsert_chunk(progress, {"index": index, "text": render_text, "path": str(final_chunk_path), "status": "completed", "resumed": True})
                continue

            if self._cancel_requested(job.id):
                raise SynthesisCancelledError("Synthesis cancelled by user.")

            self._update_job_progress(
                job,
                stage="synthesizing",
                percent=10 + int((index - 1) / max(len(chunk_texts), 1) * 65),
                message=self._synthesis_progress_message(engine_name, index, len(chunk_texts)),
                current_chunk=index,
                total_chunks=len(chunk_texts),
            )
            upsert_chunk(progress, {"index": index, "text": render_text, "path": str(final_chunk_path), "status": "running", "started_at": self._now_iso()})

            result_queue = ctx.Queue()
            payload = {
                "engine_name": engine_name,
                "voice_profile_id": job.voice_profile_id,
                "mode": job.mode,
                "text": render_text,
                "output_path": str(final_chunk_path),
                "speaker_wav": speaker_wav,
                "language": language,
                "prompt_text": prompt_text,
                "voice_profile_report": voice_profile_report,
                "candidate": locked_candidate,
                "attempt_count": int(self.settings.synthesis_candidate_attempts),
            }
            process = ctx.Process(target=_synthesis_single_chunk_worker, args=(payload, result_queue))
            process.start()
            self._update_job_progress(
                job,
                stage="synthesizing",
                percent=10 + int((index - 1) / max(len(chunk_texts), 1) * 65),
                message=f"{self._synthesis_progress_message(engine_name, index, len(chunk_texts))} Worker PID {process.pid or 0} started.",
                current_chunk=index,
                total_chunks=len(chunk_texts),
                worker_pid=process.pid or 0,
                worker_started_at=self._now_iso(),
            )
            started_at = time.monotonic()
            event: dict | None = None

            try:
                while True:
                    if self._cancel_requested(job.id):
                        self._terminate_process(process)
                        raise SynthesisCancelledError("Synthesis cancelled by user.")
                    elapsed = int(time.monotonic() - started_at)
                    if elapsed >= timeout_seconds:
                        self._terminate_process(process)
                        event = {"type": "timeout", "error": f"chunk {index} exceeded timeout of {timeout_seconds}s"}
                        break
                    try:
                        event = result_queue.get(timeout=heartbeat_interval)
                        break
                    except Empty:
                        if not process.is_alive() and process.exitcode is not None:
                            event = {"type": "error", "error": f"chunk worker exited with code {process.exitcode}"}
                            break
                        self._update_job_progress(
                            job,
                            stage="synthesizing",
                            percent=10 + int((index - 1) / max(len(chunk_texts), 1) * 65),
                            message=f"{self._synthesis_progress_message(engine_name, index, len(chunk_texts))} Chunk alive for {elapsed}s.",
                            current_chunk=index,
                            total_chunks=len(chunk_texts),
                            worker_pid=process.pid or 0,
                        )
            finally:
                try:
                    result_queue.close()
                except Exception:
                    pass

            if event and event.get("type") == "done" and valid_existing_chunk(final_chunk_path):
                process.join(timeout=1)
                synthesis_payload = dict(event.get("synthesis") or {})
                verification = dict(synthesis_payload.get("clone_verification") or {})
                selection = {
                    "engine_name": locked_candidate.get("engine_name") or engine_name,
                    "label": locked_candidate.get("label"),
                    "clone_mode": locked_candidate.get("clone_mode"),
                    "selected_reason": "highest speaker-verified take after ASR, prompt-leak, and identity gates",
                    "global_prompt_locked": True,
                    "identity_verified": verification.get("status") == "verified",
                    "selected_attempt": verification.get("selected_attempt"),
                    "attempt_count": verification.get("attempt_count"),
                    "similarity": verification.get("similarity"),
                    "backcheck": verification.get("backcheck"),
                    "gate_result": verification.get("gate_result"),
                }
                synthesis_payload["candidate_selection"] = selection
                chunk_paths.append(str(final_chunk_path))
                engine_runs.append(synthesis_payload)
                candidate_selections.append(selection)
                upsert_chunk(progress, {"index": index, "text": render_text, "path": str(final_chunk_path), "status": "completed", "completed_at": self._now_iso(), "error": None})
                continue

            error = str((event or {}).get("error") or "unknown chunk failure")
            failed_chunks.append({"index": index, "error": error})
            upsert_chunk(progress, {"index": index, "text": render_text, "path": str(final_chunk_path), "status": "failed_timeout" if (event or {}).get("type") == "timeout" else "failed", "error": error, "completed_at": self._now_iso()})
            if not bool(self.settings.synthesis_allow_partial_output):
                raise XTTSInferenceError(error)
            if job.mode == "final":
                break
            continue

        if not chunk_paths:
            raise XTTSInferenceError(f"No chunks were generated successfully. Failed chunks: {failed_chunks}")

        return {
            "chunk_paths": chunk_paths,
            "engine_runs": engine_runs or [{"engine": engine_name, "candidate_selection": {"label": locked_candidate.get("label")}}],
            "candidate_selections": candidate_selections,
            "qualified_candidates": qualified_candidates,
            "smoke_test_failures": smoke_failures,
            "failed_chunks": failed_chunks,
            "partial": bool(failed_chunks) or len(chunk_paths) < len(chunk_texts),
            "progress_manifest_path": str(progress_path),
        }

    def _terminate_process(self, process: mp.Process) -> None:
        if not process.is_alive():
            return
        process.terminate()
        process.join(timeout=5)
        if process.is_alive():
            try:
                process.kill()
            except Exception:
                pass
            process.join(timeout=5)

    def _cancel_requested(self, job_id: str) -> bool:
        probe_db = SessionLocal()
        try:
            fresh = probe_db.get(SynthesisJob, job_id)
            if fresh is None:
                return False
            request = json.loads(fresh.request_json or "{}")
            return bool(request.get("cancel_requested"))
        finally:
            probe_db.close()

    def _mark_stale_if_needed(self, job: SynthesisJob) -> None:
        if job.status not in {"running", "cancel_requested"}:
            return
        request = json.loads(job.request_json or "{}")
        heartbeat_raw = request.get("last_heartbeat_at")
        heartbeat_at = self._parse_datetime(heartbeat_raw)
        if heartbeat_at is None:
            heartbeat_at = self._normalize_datetime(getattr(job, "updated_at", None))
        if heartbeat_at is None:
            return
        now = datetime.now(timezone.utc)
        if (now - heartbeat_at).total_seconds() < int(self.settings.synthesis_stale_seconds):
            return
        request["progress"] = {
            "stage": "failed",
            "percent": 100,
            "message": "Synthesis job became stale with no heartbeat updates. The engine worker likely crashed or was terminated.",
            "current_chunk": int((request.get("progress") or {}).get("current_chunk", 0) or 0),
            "total_chunks": int((request.get("progress") or {}).get("total_chunks", 0) or 0),
        }
        request["last_heartbeat_at"] = self._now_iso()
        job.request_json = json.dumps(request)
        job.status = "failed"
        self.db.add(job)
        self.db.commit()

    def _normalize_datetime(self, value) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, datetime):
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _parse_datetime(self, raw: str | None) -> datetime | None:
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(str(raw))
        except Exception:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _mark_job_timing_completed(self, job: SynthesisJob) -> None:
        request = json.loads(job.request_json or "{}")
        completed_at = self._now_iso()
        started_at = request.get("synthesis_started_at") or completed_at
        request["synthesis_started_at"] = started_at
        request["synthesis_completed_at"] = completed_at
        request["synthesis_elapsed_seconds"] = self._elapsed_seconds(started_at, completed_at)
        job.request_json = json.dumps(request)

    def _elapsed_seconds(self, start: str | None, end: str | None = None) -> float | None:
        if not start:
            return None
        try:
            start_dt = self._parse_datetime(start)
            end_dt = self._parse_datetime(end) if end else datetime.now(timezone.utc)
            if start_dt is None or end_dt is None:
                return None
            return round(max(0.0, (end_dt - start_dt).total_seconds()), 3)
        except Exception:
            return None

    def _iso_datetime(self, value) -> str | None:
        parsed = self._normalize_datetime(value)
        return parsed.isoformat() if parsed else None

    def _audio_quality_payload(self, *, source_quality, generated_quality, delivery_quality) -> dict:
        generated_report = generated_quality.to_dict()
        delivery_report = delivery_quality.to_dict()
        for field in ("integrated_lufs", "loudness_range_lu", "true_peak_db", "bits_per_sample"):
            if delivery_report.get(field) is not None:
                generated_report[field] = delivery_report[field]
        generated_report["path"] = delivery_report.get("path") or generated_report.get("path")
        return {
            "source": source_quality.to_dict(),
            "generated": generated_report,
            "delivery": delivery_report,
            "comparison": self.audio_quality.compare(source_quality, generated_quality),
            "recommendations": self.audio_quality.recommend_actions(generated_quality, context="generated"),
        }

    def _apply_inter_chunk_pauses(self, chunk_paths: list[str], chunk_texts: list[str], *, chunk_join_hints: list[str] | None = None) -> list[str]:
        if len(chunk_paths) <= 1:
            return chunk_paths
        try:
            import numpy as np
            import soundfile as sf
        except Exception:
            return chunk_paths

        processed_chunks: list = []
        sample_rate: int | None = None
        channels: int | None = None
        for index, chunk_path in enumerate(chunk_paths):
            path = Path(chunk_path)
            if not path.exists():
                continue
            try:
                audio, current_sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
                if sample_rate is None:
                    sample_rate = int(current_sample_rate)
                    channels = int(audio.shape[1])
                if int(current_sample_rate) != sample_rate:
                    return chunk_paths
                if int(audio.shape[1]) != int(channels or audio.shape[1]):
                    return chunk_paths
                processed = self._trim_edge_silence(
                    audio,
                    sample_rate,
                    trim_start=index > 0,
                    trim_end=index < len(chunk_paths) - 1,
                )
                processed_chunks.append(processed.astype(np.float32, copy=False))
            except Exception:
                return chunk_paths

        if not processed_chunks or sample_rate is None:
            return chunk_paths

        try:
            stitched = processed_chunks[0]
            for index, next_chunk in enumerate(processed_chunks[1:], start=1):
                previous_text = chunk_texts[index - 1] if index - 1 < len(chunk_texts) else ""
                hint = chunk_join_hints[index - 1] if chunk_join_hints and index - 1 < len(chunk_join_hints) else None
                pause_ms = self._pause_ms_for_text(previous_text, join_hint=hint)
                stitched = self._join_chunks_smoothly(
                    stitched,
                    next_chunk,
                    np=np,
                    sample_rate=sample_rate,
                    pause_ms=pause_ms,
                    crossfade_ms=int(self.settings.synthesis_chunk_crossfade_ms),
                    seed=index + 17,
                )
            stitched = self._apply_edge_fades(
                stitched,
                sample_rate,
                fade_in_ms=0,
                fade_out_ms=int(self.settings.synthesis_chunk_fade_ms),
            )
            first_path = Path(chunk_paths[0])
            stitched_path = first_path.parent / "stitched-smooth.wav"
            output_audio = stitched[:, 0] if stitched.shape[1] == 1 else stitched
            sf.write(str(stitched_path), output_audio, sample_rate)
            return [str(stitched_path)]
        except Exception:
            return chunk_paths

    def _join_chunks_smoothly(self, previous, next_chunk, *, np, sample_rate: int, pause_ms: int, crossfade_ms: int, seed: int):
        if previous.size == 0:
            return next_chunk
        if next_chunk.size == 0:
            return previous

        crossfade_frames = min(
            int(sample_rate * (max(0, crossfade_ms) / 1000.0)),
            max(0, len(previous) - 1),
            max(0, len(next_chunk) - 1),
        )
        if crossfade_frames >= 2:
            fade_out = np.linspace(1.0, 0.0, crossfade_frames, dtype=np.float32).reshape(-1, 1)
            fade_in = np.linspace(0.0, 1.0, crossfade_frames, dtype=np.float32).reshape(-1, 1)
            overlap = (previous[-crossfade_frames:] * fade_out) + (next_chunk[:crossfade_frames] * fade_in)
            joined = np.concatenate([previous[:-crossfade_frames], overlap, next_chunk[crossfade_frames:]], axis=0)
        else:
            joined = np.concatenate([previous, next_chunk], axis=0)

        if pause_ms <= 0:
            return joined
        pause = self._build_comfort_noise_pause(
            np=np,
            sample_rate=sample_rate,
            channels=joined.shape[1],
            pause_ms=pause_ms,
            seed=seed,
        )
        if pause.size == 0:
            return joined
        insertion = max(0, len(previous) - crossfade_frames)
        return np.concatenate([joined[:insertion], pause, joined[insertion:]], axis=0)

    def _legacy_apply_inter_chunk_pauses(self, chunk_paths: list[str], chunk_texts: list[str], *, chunk_join_hints: list[str] | None = None) -> list[str]:
        try:
            import numpy as np
            import soundfile as sf
        except Exception:
            return chunk_paths

        adjusted_paths: list[str] = []
        for index, chunk_path in enumerate(chunk_paths):
            path = Path(chunk_path)
            if not path.exists():
                adjusted_paths.append(chunk_path)
                continue
            try:
                audio, sample_rate = sf.read(str(path), always_2d=True)
                processed = self._trim_edge_silence(
                    audio,
                    sample_rate,
                    trim_start=index > 0,
                    trim_end=index < len(chunk_paths) - 1,
                )
                processed = self._apply_edge_fades(
                    processed,
                    sample_rate,
                    fade_in_ms=int(self.settings.synthesis_chunk_fade_ms if index > 0 else 0),
                    fade_out_ms=int(self.settings.synthesis_chunk_fade_ms if index < len(chunk_paths) - 1 else 0),
                )
                if index < len(chunk_paths) - 1:
                    text = chunk_texts[index] if index < len(chunk_texts) else ""
                    hint = chunk_join_hints[index] if chunk_join_hints and index < len(chunk_join_hints) else None
                    pause_ms = self._pause_ms_for_text(text, join_hint=hint)
                    pause = self._build_comfort_noise_pause(
                        np=np,
                        sample_rate=sample_rate,
                        channels=processed.shape[1],
                        pause_ms=pause_ms,
                        seed=index + 17,
                    )
                    if pause.size:
                        processed = np.concatenate([processed, pause], axis=0)
                adjusted = processed[:, 0] if processed.shape[1] == 1 else processed
                paused_path = path.with_name(f"{path.stem}-paused{path.suffix}")
                sf.write(str(paused_path), adjusted, sample_rate)
                adjusted_paths.append(str(paused_path))
            except Exception:
                adjusted_paths.append(chunk_path)
        return adjusted_paths

    def _trim_edge_silence(self, audio, sample_rate: int, *, trim_start: bool, trim_end: bool):
        try:
            import numpy as np
        except Exception:
            return audio
        if audio.size == 0:
            return audio
        frame_levels = np.max(np.abs(audio), axis=1)
        threshold = float(10 ** (float(self.settings.synthesis_trim_edge_silence_threshold_dbfs) / 20.0))
        max_trim_frames = max(0, int(sample_rate * (int(self.settings.synthesis_trim_edge_silence_ms) / 1000.0)))
        start_index = 0
        end_index = len(frame_levels)
        if trim_start:
            while start_index < min(len(frame_levels), max_trim_frames) and frame_levels[start_index] <= threshold:
                start_index += 1
        if trim_end:
            trimmed = 0
            while end_index > start_index and trimmed < max_trim_frames and frame_levels[end_index - 1] <= threshold:
                end_index -= 1
                trimmed += 1
        trimmed_audio = audio[start_index:end_index]
        return trimmed_audio if len(trimmed_audio) else audio

    def _apply_edge_fades(self, audio, sample_rate: int, *, fade_in_ms: int, fade_out_ms: int):
        try:
            import numpy as np
        except Exception:
            return audio
        if audio.size == 0:
            return audio
        processed = np.array(audio, copy=True)
        if fade_in_ms > 0:
            fade_in_frames = min(len(processed), max(1, int(sample_rate * (fade_in_ms / 1000.0))))
            processed[:fade_in_frames] *= np.linspace(0.15, 1.0, fade_in_frames, dtype=processed.dtype).reshape(-1, 1)
        if fade_out_ms > 0:
            fade_out_frames = min(len(processed), max(1, int(sample_rate * (fade_out_ms / 1000.0))))
            processed[-fade_out_frames:] *= np.linspace(1.0, 0.18, fade_out_frames, dtype=processed.dtype).reshape(-1, 1)
        return processed

    def _build_comfort_noise_pause(self, *, np, sample_rate: int, channels: int, pause_ms: int, seed: int):
        if pause_ms <= 0:
            return np.zeros((0, channels), dtype=np.float32)
        pause_frames = max(1, int(sample_rate * (pause_ms / 1000.0)))
        rng = np.random.default_rng(seed)
        pause = rng.uniform(-4e-5, 4e-5, size=(pause_frames, channels)).astype(np.float32)
        edge_frames = min(max(1, int(sample_rate * 0.008)), pause_frames)
        ramp = np.linspace(0.35, 1.0, edge_frames, dtype=np.float32).reshape(-1, 1)
        pause[:edge_frames] *= ramp
        pause[-edge_frames:] *= ramp[::-1]
        return pause

    def _pause_ms_for_text(self, text: str, *, join_hint: str | None = None) -> int:
        trimmed = (text or "").strip()
        if not trimmed:
            return int(self.settings.synthesis_pause_default_ms)
        normalized_hint = str(join_hint or "").strip().lower()
        if normalized_hint == "paragraph":
            return int(self.settings.synthesis_pause_paragraph_ms)
        if normalized_hint == "clause":
            return int(self.settings.synthesis_pause_clause_ms)
        if normalized_hint == "sentence":
            return int(self.settings.synthesis_pause_sentence_ms)
        if trimmed.endswith((".", "?", "!")):
            return int(self.settings.synthesis_pause_sentence_ms)
        if trimmed.endswith((",", ";", ":")):
            return int(self.settings.synthesis_pause_clause_ms)
        return int(self.settings.synthesis_pause_default_ms)
