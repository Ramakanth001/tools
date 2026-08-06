from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any

from app.core.config import get_settings
from app.services.audio_artifacts import inspect_audio_artifact, validate_voxcpm_reference_audio
from app.services.transcription import AutoTranscriptionService


@dataclass
class DatasetRecord:
    index: int
    audio_path: str
    text: str
    duration_seconds: float
    word_count: int
    score: float
    source: str
    split: str
    asr_provider: str = "unknown"
    asr_confidence: float = 0.0
    asr_wer: float | None = None
    source_start_sec: float | None = None
    source_end_sec: float | None = None
    expected_duration_sec: float | None = None
    actual_duration_sec: float | None = None
    duration_ratio_actual_to_expected: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    frames: int | None = None
    non_silent_duration_sec: float | None = None
    rms_dbfs: float | None = None
    peak_dbfs: float | None = None
    safe_for_prompt: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class VoiceDatasetBuilder:
    """Builds clone-ready profile artifacts from SRT-curated speech segments.

    This is intentionally separate from synthesis.  A high-quality clone starts
    with a clean, transcript-aligned segment dataset and a short exact
    prompt-audio/prompt-text pair.  The previous XTTS path mostly built one
    conditioning derivative; this builder creates the artifacts needed by
    VoxCPM2 ultimate cloning, Chatterbox prompt cloning, and future LoRA jobs.
    """

    def __init__(self) -> None:
        self.settings = get_settings()
        self.ffmpeg_path = shutil.which("ffmpeg")
        self.ffprobe_path = shutil.which("ffprobe")
        self.transcriber = AutoTranscriptionService()

    def build(
        self,
        *,
        source_audio_path: str,
        processed_audio_path: str,
        transcript_text: str,
        output_dir: str,
        curation_report: dict[str, Any] | None = None,
        progress_callback=None,
    ) -> dict[str, Any]:
        progress_callback = progress_callback or (lambda _update: None)
        dataset_dir = Path(output_dir) / "voice_dataset"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = dataset_dir / "manifest.jsonl"
        train_path = dataset_dir / "train.jsonl"
        validation_path = dataset_dir / "validation.jsonl"
        test_path = dataset_dir / "test.jsonl"
        prompts_dir = dataset_dir / "prompts"
        prompts_dir.mkdir(parents=True, exist_ok=True)

        curation = curation_report or {}
        selected_segments = list(curation.get("selected_segments") or [])
        records, rejected = self._records_from_selected_segments(selected_segments, progress_callback=progress_callback)

        if not records:
            fallback_record = self._fallback_prompt_record(
                processed_audio_path=processed_audio_path,
                transcript_text=transcript_text,
                prompts_dir=prompts_dir,
            )
            if fallback_record:
                records = [fallback_record]
            else:
                rejected.append({"reason": "No usable SRT segments and fallback prompt extraction failed."})

        records = self._assign_splits(records)
        curated_aggregate_path = str((curation_report or {}).get("curated_audio_path") or "").strip()
        curated_aggregate_seconds = self._duration_seconds(Path(curated_aggregate_path)) if curated_aggregate_path else 0.0
        self._write_jsonl(manifest_path, [record.to_dict() for record in records])
        self._write_jsonl(train_path, [record.to_dict() for record in records if record.split == "train"])
        self._write_jsonl(validation_path, [record.to_dict() for record in records if record.split == "validation"])
        self._write_jsonl(test_path, [record.to_dict() for record in records if record.split == "test"])

        progress_callback(
            {
                "stage": "selecting_clone_prompt",
                "percent": 98,
                "message": "Selecting exact prompt audio/text for stable voice cloning.",
                "accepted_segments": len(records),
                "rejected_segments": len(rejected),
            }
        )
        prompt = self._build_prompt_artifacts(records=records, prompts_dir=prompts_dir)
        progress_callback(
            {
                "stage": "finalizing_clone_dataset",
                "percent": 99,
                "message": "Writing clone dataset manifests and readiness report.",
                "accepted_segments": len(records),
                "rejected_segments": len(rejected),
            }
        )
        record_seconds = round(sum(record.duration_seconds for record in records), 2)
        total_seconds = round(max(record_seconds, curated_aggregate_seconds), 2)
        train_seconds = round(sum(record.duration_seconds for record in records if record.split == "train"), 2)
        status = self._dataset_status(records, total_seconds, prompt)
        report = {
            "status": status,
            "purpose": "curated_voice_clone_dataset",
            "source_audio_path": source_audio_path,
            "processed_audio_path": processed_audio_path,
            "dataset_dir": str(dataset_dir),
            "manifest_path": str(manifest_path),
            "train_manifest_path": str(train_path),
            "validation_manifest_path": str(validation_path),
            "test_manifest_path": str(test_path),
            "accepted_segment_count": len(records),
            "rejected_segment_count": len(rejected),
            "curated_seconds": total_seconds,
            "record_curated_seconds": record_seconds,
            "curated_aggregate_audio_path": curated_aggregate_path or None,
            "curated_aggregate_seconds": round(curated_aggregate_seconds, 2),
            "curated_aggregate_minutes": round(curated_aggregate_seconds / 60.0, 2) if curated_aggregate_seconds else 0.0,
            "train_seconds": train_seconds,
            "curated_minutes": round(total_seconds / 60.0, 2),
            "raw_audio_duration_seconds": self._duration_seconds(Path(source_audio_path)),
            "srt_entry_count": len(selected_segments) + len(rejected),
            "prompt": prompt,
            "engine_readiness": self._engine_readiness(records=records, total_seconds=total_seconds, prompt=prompt),
            "quality_policy": {
                "min_segment_seconds": self.settings.voice_dataset_min_segment_seconds,
                "max_segment_seconds": self.settings.voice_dataset_max_segment_seconds,
                "preferred_prompt_seconds": self.settings.voice_prompt_target_seconds,
                "ideal_training_minutes": "30-60 minutes curated single-speaker speech",
            },
            "rejected_preview": rejected[:50],
            "top_rejection_reasons": self._top_rejection_reasons(rejected),
            "prompt_bank_collapse_detected": len(records) < 5,
            "notes": [
                "This dataset is the source of truth for real cloning. Mastering cannot fix a bad speaker profile.",
                "VoxCPM2 ultimate cloning should use prompt.prompt_audio_path_16k plus prompt.prompt_text when available.",
                "Future LoRA/adaptation should train only from manifest/train/validation/test, not raw full-length audio.",
            ],
        }
        (dataset_dir / "curation_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report

    def _top_rejection_reasons(self, rejected: list[dict[str, Any]]) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for item in rejected:
            reason = str(item.get("reason") or "unknown")
            counts[reason] = counts.get(reason, 0) + 1
        return [{"reason": reason, "count": count} for reason, count in sorted(counts.items(), key=lambda pair: pair[1], reverse=True)[:20]]

    def _records_from_selected_segments(self, selected_segments: list[dict[str, Any]], progress_callback=None) -> tuple[list[DatasetRecord], list[dict[str, Any]]]:
        progress_callback = progress_callback or (lambda _update: None)
        records: list[DatasetRecord] = []
        rejected: list[dict[str, Any]] = []
        total_segments = len(selected_segments)
        asr_validated_segments = 0
        asr_validation_limit = max(0, int(self.settings.voice_dataset_asr_validation_max_segments or 0))
        for position, item in enumerate(selected_segments, start=1):
            progress_callback(
                {
                    "stage": "validating_clone_dataset_segments",
                    "percent": 96 + int((position / max(total_segments, 1)) * 2),
                    "message": f"Validating clone dataset segment {position}/{total_segments}.",
                    "current_segment_index": position,
                    "total_segments": total_segments,
                    "accepted_segments": len(records),
                    "rejected_segments": len(rejected),
                }
            )
            audio_path = item.get("segment_audio_path") or item.get("audio_path")
            text = self._clean_text(str(item.get("text") or ""))
            if not audio_path:
                rejected.append({"index": item.get("index"), "reason": "Missing extracted segment audio path."})
                continue
            path = Path(str(audio_path))
            if not path.exists() or path.stat().st_size <= 44:
                rejected.append({"index": item.get("index"), "reason": "Extracted segment audio is missing or empty.", "audio_path": str(path)})
                continue
            source_start_sec = item.get("source_start_sec")
            source_end_sec = item.get("source_end_sec")
            if source_start_sec is None or source_end_sec is None:
                speech = item.get("speech_analysis") or {}
                source_start_sec = speech.get("detected_start_seconds")
                source_end_sec = speech.get("detected_end_seconds")
            expected_duration = None
            if source_start_sec is not None and source_end_sec is not None:
                try:
                    expected_duration = max(0.0, float(source_end_sec) - float(source_start_sec))
                except Exception:
                    expected_duration = None
            stats = inspect_audio_artifact(path)
            validation = validate_voxcpm_reference_audio(
                path,
                manifest={"safe_for_prompt": True, "artifact_type": "model_candidate"},
                artifact_type="asr_16k_copy",
                expected_duration_sec=expected_duration,
            )
            duration = stats.duration_sec
            if duration is None or not stats.readable:
                rejected.append(
                    {
                        "index": item.get("index"),
                        "reason": "Extracted segment audio is unreadable or has unknown duration.",
                        "audio_path": str(path),
                        "expected_duration_sec": expected_duration,
                        "validation": validation.to_dict(),
                    }
                )
                continue
            word_count = len(text.split())
            reason = self._segment_rejection_reason(duration, word_count, text)
            if reason:
                rejected.append({"index": item.get("index"), "reason": reason, "audio_path": str(path), "duration_seconds": duration, "validation": validation.to_dict()})
                continue
            if self.settings.voice_dataset_validate_with_asr and asr_validation_limit and asr_validated_segments >= asr_validation_limit:
                asr_validation = {
                    "provider": "deferred_after_enrollment_cap",
                    "confidence": 0.0,
                    "wer": None,
                    "rejected": False,
                    "observed_text": "",
                    "reason": f"Per-segment ASR deferred after {asr_validation_limit} enrollment checks to avoid blocking profile creation.",
                }
            else:
                if self.settings.voice_dataset_validate_with_asr:
                    asr_validated_segments += 1
                    progress_callback(
                        {
                            "stage": "asr_validating_clone_segment",
                            "percent": 96 + int((position / max(total_segments, 1)) * 2),
                            "message": f"ASR-validating clone segment {position}/{total_segments} ({asr_validated_segments}/{asr_validation_limit or total_segments}).",
                            "current_segment_index": position,
                            "total_segments": total_segments,
                            "accepted_segments": len(records),
                            "rejected_segments": len(rejected),
                        }
                    )
                asr_validation = self._segment_asr_validation(path, text)
            if asr_validation.get("rejected"):
                rejected.append(
                    {
                        "index": item.get("index"),
                        "reason": asr_validation.get("reason") or "Segment ASR validation failed.",
                        "audio_path": str(path),
                        "duration_seconds": duration,
                        "asr": asr_validation,
                    }
                )
                continue
            score = self._segment_score(duration, word_count, item.get("speech_analysis") or {}, asr_validation)
            records.append(
                DatasetRecord(
                    index=len(records) + 1,
                    audio_path=str(path),
                    text=text,
                    duration_seconds=round(duration, 3),
                    word_count=word_count,
                    score=score,
                    source="srt_curated_segment",
                    split="train",
                    asr_provider=str(asr_validation.get("provider") or "unknown"),
                    asr_confidence=float(asr_validation.get("confidence") or 0.0),
                    asr_wer=float(asr_validation["wer"]) if asr_validation.get("wer") is not None else None,
                    source_start_sec=float(source_start_sec) if source_start_sec is not None else None,
                    source_end_sec=float(source_end_sec) if source_end_sec is not None else None,
                    expected_duration_sec=expected_duration,
                    actual_duration_sec=duration,
                    duration_ratio_actual_to_expected=validation.duration_ratio_actual_to_expected,
                    sample_rate=stats.sample_rate,
                    channels=stats.channels,
                    frames=stats.frames,
                    non_silent_duration_sec=stats.non_silent_duration_sec,
                    rms_dbfs=stats.rms_dbfs,
                    peak_dbfs=stats.peak_dbfs,
                    safe_for_prompt=(
                        duration >= float(self.settings.voice_prompt_min_seconds)
                        and duration <= float(self.settings.voice_prompt_max_seconds)
                        and (validation.duration_ratio_actual_to_expected is None or abs(1.0 - float(validation.duration_ratio_actual_to_expected)) <= float(self.settings.voice_prompt_duration_tolerance_ratio))
                    ),
                )
            )
        return records, rejected

    def _fallback_prompt_record(self, *, processed_audio_path: str, transcript_text: str, prompts_dir: Path) -> DatasetRecord | None:
        source = Path(processed_audio_path)
        if not source.exists():
            return None
        duration = min(max(self.settings.voice_prompt_target_seconds, 8), 30)
        output = prompts_dir / "fallback_prompt.wav"
        if self.ffmpeg_path:
            result = subprocess.run(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(source),
                    "-t",
                    str(duration),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0 or not output.exists():
                return None
        else:
            shutil.copyfile(source, output)

        text = self._clean_text(" ".join((transcript_text or "").split()[:45]))
        if not text:
            text = "Reference speech prompt for personal voice cloning."
        stats = inspect_audio_artifact(output)
        actual_duration = stats.duration_sec or float(duration)
        return DatasetRecord(
            index=1,
            audio_path=str(output),
            text=text,
            duration_seconds=round(actual_duration, 3),
            word_count=max(1, len(text.split())),
            score=0.55,
            source="fallback_processed_audio_prompt",
            split="train",
            expected_duration_sec=float(duration),
            actual_duration_sec=actual_duration,
            duration_ratio_actual_to_expected=(actual_duration / float(duration)) if duration else None,
            sample_rate=stats.sample_rate,
            channels=stats.channels,
            frames=stats.frames,
            non_silent_duration_sec=stats.non_silent_duration_sec,
            rms_dbfs=stats.rms_dbfs,
            peak_dbfs=stats.peak_dbfs,
            safe_for_prompt=True,
        )

    def _assign_splits(self, records: list[DatasetRecord]) -> list[DatasetRecord]:
        if len(records) < 10:
            return records
        for position, record in enumerate(records, start=1):
            if position % 20 == 0:
                record.split = "test"
            elif position % 10 == 0:
                record.split = "validation"
            else:
                record.split = "train"
        return records

    def _build_prompt_artifacts(self, *, records: list[DatasetRecord], prompts_dir: Path) -> dict[str, Any]:
        if not records:
            return {"status": "missing", "reason": "No accepted records available for prompt selection."}

        candidates = sorted(records, key=lambda record: (self._prompt_score(record), record.score), reverse=True)
        prompt_candidates = self._build_prompt_candidates(candidates=candidates, prompts_dir=prompts_dir)
        chosen: list[DatasetRecord] = []
        total = 0.0
        target = float(self.settings.voice_prompt_target_seconds)
        safe_candidates = [record for record in candidates if not self._is_hifi_quarantined_prompt(record.text)]
        candidate_pool = safe_candidates or candidates
        valid_reference_records = [
            record
            for record in candidate_pool
            if float(self.settings.voice_prompt_min_seconds) <= record.duration_seconds <= float(self.settings.voice_prompt_max_seconds)
            and record.safe_for_prompt
        ]
        for record in candidate_pool:
            if record.duration_seconds < float(self.settings.voice_prompt_min_seconds) or record.duration_seconds > float(self.settings.voice_prompt_max_seconds):
                continue
            if not record.safe_for_prompt:
                continue
            chosen.append(record)
            total += record.duration_seconds
            if total >= target:
                break
        if not chosen:
            chosen = candidate_pool[:1]
            total = sum(record.duration_seconds for record in chosen)

        model_reference_record = valid_reference_records[0] if valid_reference_records else chosen[0]

        prompt_pack_text = " ".join(record.text for record in chosen).strip()
        first_prompt = prompts_dir / "best_prompt_01.wav"
        curated_candidates = sorted(prompts_dir.parent.parent.parent.glob("srt-curated-*.wav"))
        if not curated_candidates:
            curated_candidates = sorted(prompts_dir.parent.parent.glob("srt-curated-*.wav"))
        curated_reference = curated_candidates[0] if curated_candidates else None
        use_curated_fallback = bool(
            curated_reference
            and curated_reference.exists()
            and self._duration_seconds(curated_reference) >= float(self.settings.voice_prompt_min_seconds)
            and not valid_reference_records
        )
        if use_curated_fallback:
            self._write_reference_slice(curated_reference, first_prompt)
        else:
            shutil.copyfile(model_reference_record.audio_path, first_prompt)
        first_prompt_16k = prompts_dir / "best_prompt_01_16k.wav"
        first_text = prompts_dir / "best_prompt_01.txt"
        first_text.write_text((model_reference_record.text if not use_curated_fallback else prompt_pack_text or model_reference_record.text), encoding="utf-8")
        golden_ref = prompts_dir / "golden_ref.wav"
        golden_ref_16k = prompts_dir / "golden_ref_16k.wav"
        golden_ref_text = prompts_dir / "golden_ref.txt"
        golden_ref_json = prompts_dir / "golden_ref.json"

        prompt_pack = prompts_dir / "best_prompt_pack.wav"
        prompt_pack_16k = prompts_dir / "best_prompt_pack_16k.wav"
        single_prompt_text = (prompt_pack_text if use_curated_fallback and prompt_pack_text else model_reference_record.text).strip()

        if len(chosen) == 1:
            shutil.copyfile(chosen[0].audio_path, prompt_pack)
        else:
            self._concat_prompt_files([Path(record.audio_path) for record in chosen], prompt_pack)

        if self.ffmpeg_path:
            single_result = subprocess.run(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(first_prompt),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(first_prompt_16k),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if single_result.returncode != 0 or not first_prompt_16k.exists():
                first_prompt_16k = first_prompt
            shutil.copyfile(first_prompt, golden_ref)
            if first_prompt_16k.exists():
                shutil.copyfile(first_prompt_16k, golden_ref_16k)
            else:
                shutil.copyfile(first_prompt, golden_ref_16k)

            result = subprocess.run(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(prompt_pack),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(prompt_pack_16k),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0 or not prompt_pack_16k.exists():
                prompt_pack_16k = prompt_pack
        else:
            first_prompt_16k = first_prompt
            prompt_pack_16k = prompt_pack
            shutil.copyfile(first_prompt, golden_ref)
            shutil.copyfile(first_prompt, golden_ref_16k)

        golden_ref_text.write_text(single_prompt_text, encoding="utf-8")
        golden_ref_json.write_text(
            json.dumps(
                {
                    "audio_path": str(golden_ref),
                    "audio_path_16k": str(golden_ref_16k),
                    "artifact_type": "golden_ref",
                    "safe_for_prompt": bool(model_reference_record.safe_for_prompt or use_curated_fallback),
                    "text": single_prompt_text,
                    "duration_seconds": round(self._duration_seconds(first_prompt), 3),
                    "expected_duration_sec": model_reference_record.expected_duration_sec,
                    "actual_duration_sec": model_reference_record.actual_duration_sec,
                    "duration_ratio_actual_to_expected": model_reference_record.duration_ratio_actual_to_expected,
                    "sample_rate": model_reference_record.sample_rate,
                    "channels": model_reference_record.channels,
                    "frames": model_reference_record.frames,
                    "non_silent_duration_sec": model_reference_record.non_silent_duration_sec,
                    "rms_dbfs": model_reference_record.rms_dbfs,
                    "peak_dbfs": model_reference_record.peak_dbfs,
                    "source_record": model_reference_record.to_dict(),
                    "curated_reference_source_path": str(curated_reference) if use_curated_fallback and curated_reference else None,
                    "audio_sha256": self._sha256(Path(golden_ref)),
                    "audio_16k_sha256": self._sha256(Path(golden_ref_16k)),
                    "hifi_quarantined": self._is_hifi_quarantined_prompt(single_prompt_text),
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        (prompts_dir / "best_prompt_pack.txt").write_text(prompt_pack_text, encoding="utf-8")
        return {
            "status": "ready",
            "prompt_audio_path": str(first_prompt),
            "prompt_audio_path_16k": str(first_prompt_16k),
            "single_prompt_audio_path": str(first_prompt),
            "single_prompt_audio_path_16k": str(first_prompt_16k),
            "single_prompt_text_path": str(first_text),
            "prompt_text": single_prompt_text,
            "golden_ref_audio_path": str(golden_ref),
            "golden_ref_audio_path_16k": str(golden_ref_16k),
            "golden_ref_text_path": str(golden_ref_text),
            "golden_ref_text": single_prompt_text,
            "golden_ref_manifest_path": str(golden_ref_json),
            "prompt_pack_audio_path": str(prompt_pack),
            "prompt_pack_audio_path_16k": str(prompt_pack_16k),
            "prompt_pack_text": prompt_pack_text,
            "prompt_segment_count": len(chosen),
            "prompt_seconds": round(self._duration_seconds(first_prompt), 2),
            "prompt_pack_seconds": round(total, 2),
            "model_reference_source": "curated_aggregate_fallback" if use_curated_fallback else ("validated_candidate" if valid_reference_records else "fallback_short_prompt"),
            "prompt_records": [record.to_dict() for record in chosen],
            "candidate_prompts": prompt_candidates,
        }

    def _write_reference_slice(self, source_path: Path, output_path: Path) -> None:
        target_seconds = min(
            float(self.settings.voice_prompt_max_seconds),
            max(float(self.settings.voice_prompt_target_seconds), float(self.settings.voice_prompt_min_seconds)),
        )
        if self.ffmpeg_path:
            result = subprocess.run(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-i",
                    str(source_path),
                    "-t",
                    f"{target_seconds:.3f}",
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0 and output_path.exists() and output_path.stat().st_size > 44:
                return
        shutil.copyfile(source_path, output_path)

    def _build_prompt_candidates(self, *, candidates: list[DatasetRecord], prompts_dir: Path) -> list[dict[str, Any]]:
        prompt_candidates: list[dict[str, Any]] = []
        for index, record in enumerate(candidates, start=1):
            if len(prompt_candidates) >= int(self.settings.voice_prompt_candidate_count):
                break
            if record.duration_seconds < float(self.settings.voice_prompt_min_seconds) or record.duration_seconds > float(self.settings.voice_prompt_max_seconds):
                continue
            if not record.safe_for_prompt:
                continue
            candidate_wav = prompts_dir / f"candidate_prompt_{len(prompt_candidates)+1:02d}.wav"
            candidate_wav_16k = prompts_dir / f"candidate_prompt_{len(prompt_candidates)+1:02d}_16k.wav"
            shutil.copyfile(record.audio_path, candidate_wav)
            if self.ffmpeg_path:
                result = subprocess.run(
                    [
                        self.ffmpeg_path,
                        "-y",
                        "-i",
                        str(candidate_wav),
                        "-ar",
                        "16000",
                        "-ac",
                        "1",
                        str(candidate_wav_16k),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if result.returncode != 0 or not candidate_wav_16k.exists():
                    candidate_wav_16k = candidate_wav
            else:
                candidate_wav_16k = candidate_wav

            stats = inspect_audio_artifact(candidate_wav)
            validation = validate_voxcpm_reference_audio(
                candidate_wav,
                manifest={"safe_for_prompt": record.safe_for_prompt, "artifact_type": "model_candidate"},
                artifact_type="model_candidate",
                expected_duration_sec=record.expected_duration_sec,
            )
            if not validation.valid:
                continue
            candidate_manifest = prompts_dir / f"candidate_prompt_{len(prompt_candidates)+1:02d}.json"
            candidate_payload = {
                "rank": len(prompt_candidates) + 1,
                "artifact_type": "model_candidate",
                "safe_for_prompt": validation.valid,
                "audio_path": str(candidate_wav),
                "audio_path_16k": str(candidate_wav_16k),
                "text": record.text,
                "duration_seconds": record.duration_seconds,
                "source_start_sec": record.source_start_sec,
                "source_end_sec": record.source_end_sec,
                "expected_duration_sec": record.expected_duration_sec,
                "actual_duration_sec": stats.duration_sec,
                "duration_ratio_actual_to_expected": validation.duration_ratio_actual_to_expected,
                "sample_rate": stats.sample_rate,
                "channels": stats.channels,
                "frames": stats.frames,
                "non_silent_duration_sec": stats.non_silent_duration_sec,
                "rms_dbfs": stats.rms_dbfs,
                "peak_dbfs": stats.peak_dbfs,
                "score": record.score,
                "asr_provider": record.asr_provider,
                "asr_confidence": record.asr_confidence,
                "asr_wer": record.asr_wer,
                "audio_sha256": self._sha256(candidate_wav),
                "audio_16k_sha256": self._sha256(candidate_wav_16k),
                "text_sha256": self._sha256_text(record.text),
                "hifi_leak_failed": self._is_hifi_quarantined_prompt(record.text),
                "validation": validation.to_dict(),
            }
            candidate_manifest.write_text(json.dumps(candidate_payload, indent=2), encoding="utf-8")

            prompt_candidates.append(candidate_payload | {"manifest_path": str(candidate_manifest)})
        return prompt_candidates

    def _concat_prompt_files(self, paths: list[Path], output_path: Path) -> None:
        if not self.ffmpeg_path:
            shutil.copyfile(paths[0], output_path)
            return
        concat_list = output_path.with_suffix(".concat.txt")
        concat_list.write_text("".join(f"file '{self._escape_concat_path(path)}'\n" for path in paths), encoding="utf-8")
        try:
            result = subprocess.run(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(concat_list),
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0 or not output_path.exists():
                shutil.copyfile(paths[0], output_path)
        finally:
            concat_list.unlink(missing_ok=True)

    def _dataset_status(self, records: list[DatasetRecord], total_seconds: float, prompt: dict[str, Any]) -> str:
        if prompt.get("status") != "ready":
            return "not_ready"
        if len(records) >= 250 and total_seconds >= 1800:
            return "adaptation_ready"
        if len(records) >= 40 and total_seconds >= 300:
            return "zero_shot_ready"
        return "limited_prompt_ready"

    def _engine_readiness(self, *, records: list[DatasetRecord], total_seconds: float, prompt: dict[str, Any]) -> dict[str, Any]:
        prompt_ready = (
            prompt.get("status") == "ready"
            and bool(prompt.get("prompt_text"))
            and float(prompt.get("prompt_seconds") or 0.0) >= float(self.settings.voice_prompt_min_seconds)
        )
        return {
            "voxcpm2_ultimate_clone": "ready" if prompt_ready else "missing_prompt",
            "voxcpm2_lora_candidate": total_seconds >= 1800 and len(records) >= 250,
            "chatterbox_prompt_clone": "ready" if prompt_ready else "missing_prompt",
            "xtts_legacy_reference": "available" if prompt_ready else "fallback_only",
            "recommended_next_step": "run_voxcpm2_zero_shot_bakeoff" if prompt_ready else "rebuild_profile_or_fix_prompt_extraction",
        }

    def _segment_rejection_reason(self, duration_seconds: float, word_count: int, text: str) -> str | None:
        if duration_seconds < self.settings.voice_dataset_min_segment_seconds:
            return "Segment is too short for clone training/prompting."
        if duration_seconds > self.settings.voice_dataset_max_segment_seconds:
            return "Segment is too long for stable clone training/prompting."
        if word_count < 2:
            return "Transcript has too few words."
        if not text:
            return "Cleaned transcript is empty."
        return None

    def _segment_score(self, duration_seconds: float, word_count: int, speech_analysis: dict[str, Any], asr_validation: dict[str, Any]) -> float:
        duration_score = max(0.0, 1.0 - abs(duration_seconds - 8.0) / 12.0)
        word_score = max(0.0, min(1.0, word_count / 16.0))
        coverage = float(speech_analysis.get("speech_coverage_percent") or 80.0) / 100.0
        asr_bonus = 1.0
        if asr_validation.get("wer") is not None:
            asr_bonus = max(0.0, 1.0 - float(asr_validation.get("wer") or 0.0))
        return round(max(0.05, min(0.99, (duration_score * 0.4) + (word_score * 0.2) + (coverage * 0.2) + (asr_bonus * 0.2))), 3)

    def _prompt_score(self, record: DatasetRecord) -> float:
        duration_preference = max(0.0, 1.0 - abs(record.duration_seconds - 9.0) / 10.0)
        word_preference = 1.0 if 6 <= record.word_count <= 35 else 0.55
        quarantine_penalty = 0.35 if self._is_hifi_quarantined_prompt(record.text) else 0.0
        return max(0.0, (duration_preference * 0.55) + (word_preference * 0.25) + (record.score * 0.20) - quarantine_penalty)

    def _duration_seconds(self, path: Path) -> float:
        if not self.ffprobe_path:
            return 0.0
        result = subprocess.run(
            [
                self.ffprobe_path,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            return float((result.stdout or "").strip())
        except Exception:
            return 0.0

    def _write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> None:
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")

    def _clean_text(self, text: str) -> str:
        cleaned = re.sub(r"<[^>]+>", " ", text or "")
        cleaned = re.sub(r"\{[^}]+\}", " ", cleaned)
        cleaned = cleaned.replace("&", " and ")
        cleaned = cleaned.replace("—", "-").replace("–", "-")
        cleaned = re.sub(r"^\s*(?:speaker|narrator|host|male|female|voiceover|swami)\s*\d*\s*[:-]+\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"^\s*[A-Za-z][A-Za-z' ]{0,30}\s+(?:replies?|reply|says?|said|asks?|asked|speaks?)\s*[:-]+\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"^\s*\[[^\]]{0,30}\]\s*", "", cleaned)
        cleaned = re.sub(r"^\s*\([^\)]{0,30}\)\s*", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
        return cleaned.strip()

    def _segment_asr_validation(self, audio_path: Path, expected_text: str) -> dict[str, Any]:
        if not self.settings.voice_dataset_validate_with_asr:
            return {"provider": "disabled", "confidence": 0.0, "wer": None, "rejected": False}
        transcription = self.transcriber.transcribe(str(audio_path))
        provider = str(transcription.get("provider") or "unknown")
        is_measured = bool(transcription.get("is_measured", provider == "faster-whisper"))
        confidence = float(transcription.get("confidence") or 0.0)
        observed_text = self._clean_text(str(transcription.get("text") or ""))
        if not is_measured:
            return {
                "provider": provider,
                "confidence": confidence,
                "wer": None,
                "rejected": False,
                "observed_text": observed_text,
            }
        wer = self._word_error_rate(expected_text, observed_text)
        rejected = (
            bool(observed_text)
            and bool(self.settings.voice_dataset_hard_reject_with_asr)
            and confidence >= float(self.settings.voice_dataset_hard_reject_min_confidence)
            and wer > float(self.settings.voice_dataset_max_segment_wer)
        )
        return {
            "provider": provider,
            "confidence": confidence,
            "wer": wer,
            "rejected": rejected,
            "reason": f"Segment ASR WER {wer:.3f} exceeds threshold {self.settings.voice_dataset_max_segment_wer:.2f}." if rejected else None,
            "observed_text": observed_text,
        }

    def _word_error_rate(self, expected_text: str, observed_text: str) -> float:
        expected_words = self._normalize_for_wer(expected_text).split()
        observed_words = self._normalize_for_wer(observed_text).split()
        if not expected_words:
            return 0.0 if not observed_words else 1.0

        rows = len(expected_words) + 1
        cols = len(observed_words) + 1
        matrix = [[0] * cols for _ in range(rows)]
        for i in range(rows):
            matrix[i][0] = i
        for j in range(cols):
            matrix[0][j] = j

        for i in range(1, rows):
            for j in range(1, cols):
                cost = 0 if expected_words[i - 1] == observed_words[j - 1] else 1
                matrix[i][j] = min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost,
                )
        return round(matrix[-1][-1] / max(len(expected_words), 1), 3)

    def _normalize_for_wer(self, text: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())).strip()

    def _is_hifi_quarantined_prompt(self, text: str) -> bool:
        normalized = self._normalize_for_wer(text)
        return "with respect to the spectator" in normalized

    def _sha256(self, path: Path) -> str | None:
        if not path.exists() or not path.is_file():
            return None
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _sha256_text(self, text: str) -> str:
        return hashlib.sha256((text or "").encode("utf-8")).hexdigest()

    def _escape_concat_path(self, path: Path) -> str:
        return path.resolve().as_posix().replace("'", "'\\''")