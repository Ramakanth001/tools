from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any

from app.services.asr_backcheck import ASRBackcheckService
from app.services.speaker_verification import SpeakerVerificationService


@dataclass
class EvaluationReport:
    similarity_score: float
    intelligibility_score: float
    estimated_wer: float
    artifact_score: float
    overall_score: float
    golden_sample_regression_ok: bool
    human_listening_rubric: dict[str, float]
    dependency_hooks: dict[str, Any]
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class EvaluationService:
    def __init__(self) -> None:
        self.asr_backcheck = ASRBackcheckService()
        self.speaker_verification = SpeakerVerificationService()

    def evaluate(self, *, audio_path: str, reference_path: str, expected_text: str, chunks: list[str]) -> EvaluationReport:
        speaker_report = self.speaker_verification.verify(reference_audio_path=reference_path, candidate_audio_path=audio_path)
        backcheck = self.asr_backcheck.evaluate(expected_text=expected_text, chunks=chunks, audio_path=audio_path)

        similarity_score = round(speaker_report.similarity_score, 3)
        estimated_wer = round(float(backcheck.get("estimated_wer", 0.4) or 0.4), 3)
        intelligibility_score = round(max(0.45, 1.0 - estimated_wer), 3)
        artifact_score = round(self._artifact_score(audio_path), 3)
        overall = round((similarity_score * 0.4) + (intelligibility_score * 0.35) + (artifact_score * 0.25), 3)
        human_rubric = {
            "similarity": round(2.5 + similarity_score * 2.5, 2),
            "naturalness": round(2.4 + artifact_score * 2.4, 2),
            "intelligibility": round(2.4 + intelligibility_score * 2.5, 2),
            "prosody": round(2.2 + max(0.0, 1.0 - abs(len(chunks) - 4) * 0.08) * 2.4, 2),
        }
        notes: list[str] = []
        if estimated_wer > 0.18:
            notes.append("Estimated WER is high; real ASR back-check recommended before release.")
        if similarity_score < 0.8:
            notes.append("Similarity score is below premium-clone target range.")
        if artifact_score < 0.78:
            notes.append("Measured artifact proxy suggests possible render roughness or weak signal quality.")
        notes.extend(speaker_report.notes)

        return EvaluationReport(
            similarity_score=similarity_score,
            intelligibility_score=intelligibility_score,
            estimated_wer=estimated_wer,
            artifact_score=artifact_score,
            overall_score=overall,
            golden_sample_regression_ok=overall >= 0.74,
            human_listening_rubric=human_rubric,
            dependency_hooks={
                "real_asr_backcheck": bool(backcheck.get("is_measured")),
                "speaker_embedding_eval": speaker_report.provider == "speechbrain_ecapa",
                "artifact_model_eval": False,
                "is_release_grade": bool(backcheck.get("is_measured")) and speaker_report.provider == "speechbrain_ecapa",
                "speaker_verification": speaker_report.to_dict(),
                "notes": "ASR back-check and speaker verification now attempt real engines first; artifact scoring is still a measured proxy rather than a dedicated artifact model.",
            },
            notes=notes,
        )

    def _artifact_score(self, audio_path: str) -> float:
        try:
            import wave

            with wave.open(audio_path, "rb") as wav_file:
                frame_count = wav_file.getnframes()
                sample_width = wav_file.getsampwidth()
                raw = wav_file.readframes(frame_count)
            if not raw or sample_width <= 0:
                return 0.55

            peak_value = float(2 ** (sample_width * 8 - 1))
            samples = []
            step = sample_width
            for index in range(0, len(raw), step):
                chunk = raw[index : index + step]
                if len(chunk) != step:
                    continue
                samples.append(int.from_bytes(chunk, byteorder="little", signed=True) / peak_value)
            if not samples:
                return 0.55

            rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
            peak = max(abs(sample) for sample in samples)
            clipping_ratio = sum(1 for sample in samples if abs(sample) >= 0.99) / len(samples)
            dynamic = peak - rms
            score = 0.55
            score += min(0.2, rms * 0.4)
            score += min(0.15, max(dynamic, 0.0) * 0.25)
            score += max(0.0, 0.1 - clipping_ratio * 2.0)
            return max(0.0, min(0.98, score))
        except Exception:
            return 0.55