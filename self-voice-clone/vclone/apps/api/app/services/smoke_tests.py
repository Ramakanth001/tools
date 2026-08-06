from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.voice_profile import VoiceProfile
from app.services.asr_backcheck import ASRBackcheckService
from app.services.audio_artifacts import validate_voxcpm_reference_audio
from app.services.candidate_gating import CandidateGateService
from app.services.engine_registry import EngineRegistry
from app.services.similarity_calibration import SimilarityCalibrationService
from app.services.speaker_verification import SpeakerVerificationService
from app.services.synthesis import SynthesisService, _SMOKE_TEST_SENTENCE


class SmokeTestService:
    def __init__(self, db: Session | None = None) -> None:
        self.db = db
        self.settings = get_settings()
        self.root_dir = Path("uploads") / "diagnostics" / "smoke-tests"
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def create_job(self, *, voice_profile_id: str, mode: str = "preview", engine_name: str = "voxcpm2", candidate_limit: int | None = None) -> dict:
        if self.db is None:
            raise ValueError("Database session is required to create a smoke test")
        profile = self.db.get(VoiceProfile, voice_profile_id)
        if profile is None:
            raise ValueError("Voice profile not found")

        job_id = str(uuid4())
        job_dir = self._job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        limit = max(1, min(int(candidate_limit or self.settings.synthesis_diagnostic_candidate_limit), int(self.settings.voice_prompt_candidate_count)))
        status = {
            "job_id": job_id,
            "status": "queued",
            "voice_profile_id": voice_profile_id,
            "mode": mode or "preview",
            "engine_name": engine_name or "voxcpm2",
            "candidate_limit": limit,
            "progress": {"stage": "queued", "percent": 0, "message": "Smoke/mock test queued.", "current_candidate": 0, "total_candidates": 0},
            "results": [],
            "error": None,
            "created_at": self._now(),
            "updated_at": self._now(),
        }
        self._write_status(job_id, status)
        return status

    def run_job(self, job_id: str) -> None:
        if self.db is None:
            raise ValueError("Database session is required to run a smoke test")
        status = self.get_status(job_id)
        profile = self.db.get(VoiceProfile, status["voice_profile_id"])
        if profile is None:
            self._fail(job_id, "Voice profile not found")
            return

        job_dir = self._job_dir(job_id)
        try:
            self._update(job_id, status="running", progress={"stage": "preparing", "percent": 5, "message": "Preparing smoke/mock test candidates.", "current_candidate": 0, "total_candidates": 0})
            synthesis = SynthesisService(self.db)
            profile_report = synthesis._profile_report(profile)
            reference_path, prompt_text = synthesis._resolve_clone_reference(profile, profile_report)
            candidates = synthesis._build_candidate_plan(str(status.get("engine_name") or "voxcpm2"), profile_report, reference_path, prompt_text, str(status.get("mode") or "preview"))
            candidates = candidates[: max(1, int(status.get("candidate_limit") or self.settings.synthesis_diagnostic_candidate_limit))]
            if not candidates:
                raise ValueError("No smoke-test candidates are available for this voice profile")

            registry = EngineRegistry()
            asr_backcheck = ASRBackcheckService()
            candidate_gating = CandidateGateService()
            speaker_verification = SpeakerVerificationService()
            similarity_calibration = SimilarityCalibrationService().calibrate(golden_ref_path=reference_path)
            results: list[dict] = []
            total = len(candidates)

            for index, candidate in enumerate(candidates, start=1):
                if self._cancel_requested(job_id):
                    self._update(job_id, status="cancelled", progress={"stage": "cancelled", "percent": 100, "message": "Smoke/mock test cancelled.", "current_candidate": index - 1, "total_candidates": total})
                    return

                label = str(candidate.get("label") or f"candidate-{index}")
                self._update(job_id, status="running", progress={"stage": "testing_candidate", "percent": 10 + int((index - 1) / max(total, 1) * 80), "message": f"Testing {label} ({index}/{total}).", "current_candidate": index, "total_candidates": total})
                output_path = job_dir / f"candidate-{index:02d}.wav"
                result_payload = {
                    "candidate_rank": index,
                    "engine_name": candidate.get("engine_name") or status.get("engine_name"),
                    "label": label,
                    "clone_mode": candidate.get("clone_mode"),
                    "speaker_wav": candidate.get("speaker_wav"),
                    "passed": False,
                    "audio_path": None,
                    "audio_url": None,
                    "validation": None,
                    "backcheck": None,
                    "gate_result": None,
                    "similarity": None,
                    "error": None,
                }
                try:
                    validation = validate_voxcpm_reference_audio(str(candidate.get("speaker_wav") or ""), manifest=candidate, artifact_type="model_candidate", expected_duration_sec=candidate.get("expected_duration_sec"))
                    result_payload["validation"] = validation.to_dict()
                    if not validation.valid:
                        result_payload["error"] = validation.message
                        results.append(result_payload)
                        self._update(job_id, results=results)
                        continue

                    engine = registry.get_engine_by_name(str(candidate.get("engine_name") or status.get("engine_name") or "voxcpm2"))
                    synthesis_payload = engine.synthesize(
                        _SMOKE_TEST_SENTENCE,
                        str(status["voice_profile_id"]),
                        str(status.get("mode") or "preview"),
                        str(output_path),
                        speaker_wav=str(candidate.get("speaker_wav") or reference_path),
                        language="en",
                        prompt_text=str(candidate.get("prompt_text") or ""),
                        voice_profile_report=profile_report,
                        clone_mode=str(candidate.get("clone_mode") or "reference_only"),
                    )
                    backcheck = asr_backcheck.evaluate(expected_text=_SMOKE_TEST_SENTENCE, chunks=[_SMOKE_TEST_SENTENCE], audio_path=str(output_path))
                    similarity = speaker_verification.verify(reference_audio_path=str(candidate.get("speaker_wav") or reference_path), candidate_audio_path=str(output_path))
                    gate_result = candidate_gating.evaluate(
                        mode=str(status.get("mode") or "preview"),
                        target_text=_SMOKE_TEST_SENTENCE,
                        observed_text=str(backcheck.get("observed_text") or ""),
                        prompt_text=str(candidate.get("prompt_text") or ""),
                        audio_path=str(output_path),
                        backcheck=backcheck,
                        similarity=similarity.to_dict(),
                        similarity_trusted=similarity_calibration.trusted,
                    )
                    result_payload.update(
                        {
                            "passed": bool(gate_result.passed),
                            "audio_path": str(output_path),
                            "audio_url": f"/v1/synthesis/smoke-test/{job_id}/file/{output_path.name}",
                            "synthesis": synthesis_payload,
                            "backcheck": backcheck,
                            "gate_result": gate_result.to_dict(),
                            "similarity": similarity.to_dict(),
                            "error": None if gate_result.passed else "smoke_test_failed_quality_gate",
                        }
                    )
                except Exception as exc:  # noqa: BLE001 - diagnostics should continue with other candidates.
                    result_payload["error"] = f"{type(exc).__name__}: {exc}"
                results.append(result_payload)
                self._update(job_id, results=results)

            passed = sum(1 for item in results if item.get("passed"))
            self._update(job_id, status="completed", progress={"stage": "completed", "percent": 100, "message": f"Smoke/mock test completed. {passed}/{total} candidates passed.", "current_candidate": total, "total_candidates": total}, results=results)
        except Exception as exc:  # noqa: BLE001
            self._fail(job_id, f"{type(exc).__name__}: {exc}")

    def get_status(self, job_id: str) -> dict:
        path = self._status_path(job_id)
        if not path.exists():
            raise ValueError("Smoke test job not found")
        return json.loads(path.read_text(encoding="utf-8"))

    def cancel_job(self, job_id: str) -> dict:
        status = self.get_status(job_id)
        status["cancel_requested"] = True
        if status.get("status") in {"queued", "running"}:
            status["status"] = "cancel_requested"
        status["progress"] = {**(status.get("progress") or {}), "stage": "cancel_requested", "message": "Cancellation requested for smoke/mock test."}
        status["updated_at"] = self._now()
        self._write_status(job_id, status)
        return status

    def get_file_path(self, job_id: str, filename: str) -> str:
        path = self._job_dir(job_id) / Path(filename).name
        if not path.exists() or not path.is_file():
            raise ValueError("Smoke test audio file not found")
        return str(path)

    def _cancel_requested(self, job_id: str) -> bool:
        try:
            return bool(self.get_status(job_id).get("cancel_requested"))
        except Exception:
            return False

    def _fail(self, job_id: str, error: str) -> None:
        self._update(job_id, status="failed", error=error, progress={"stage": "failed", "percent": 100, "message": error})

    def _update(self, job_id: str, **changes) -> dict:
        status = self.get_status(job_id)
        status.update({key: value for key, value in changes.items() if value is not None})
        status["updated_at"] = self._now()
        self._write_status(job_id, status)
        return status

    def _write_status(self, job_id: str, payload: dict) -> None:
        path = self._status_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.part")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _job_dir(self, job_id: str) -> Path:
        return self.root_dir / job_id

    def _status_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "status.json"

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()