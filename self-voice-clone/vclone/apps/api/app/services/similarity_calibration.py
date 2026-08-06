from __future__ import annotations

from dataclasses import asdict, dataclass

from app.services.speaker_verification import SpeakerVerificationService


@dataclass
class SimilarityCalibrationResult:
    trusted: bool
    provider: str
    self_similarity_score: float
    self_similarity_passed: bool
    notes: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


class SimilarityCalibrationService:
    def __init__(self) -> None:
        self.speaker_verification = SpeakerVerificationService()

    def calibrate(self, *, golden_ref_path: str) -> SimilarityCalibrationResult:
        report = self.speaker_verification.verify(reference_audio_path=golden_ref_path, candidate_audio_path=golden_ref_path)
        trusted = report.provider == "speechbrain_ecapa" and report.passed
        notes = list(report.notes)
        if not trusted:
            notes.append("Similarity backend is not trusted for hard gating because golden_ref self-test did not pass with measured embeddings.")
        return SimilarityCalibrationResult(
            trusted=trusted,
            provider=report.provider,
            self_similarity_score=report.similarity_score,
            self_similarity_passed=report.passed,
            notes=notes,
        )