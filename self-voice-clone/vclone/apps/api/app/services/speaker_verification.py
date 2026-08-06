from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import math
import subprocess
from typing import Any


@dataclass
class SpeakerVerificationReport:
    provider: str
    similarity_score: float
    passed: bool
    threshold: float
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SpeakerVerificationService:
    _classifier_cache: dict[str, Any] = {}
    _speechbrain_unavailable_reason: str | None = None

    def __init__(self, threshold: float = 0.72) -> None:
        self.threshold = threshold

    def verify(self, *, reference_audio_path: str, candidate_audio_path: str) -> SpeakerVerificationReport:
        try:
            from speechbrain.inference.speaker import EncoderClassifier
            import torch
        except Exception:
            similarity = self._duration_similarity(reference_audio_path, candidate_audio_path)
            notes = [
                "speechbrain is not installed; using duration-based fallback instead of real speaker embeddings.",
                "Install speechbrain + torch to enable real speaker verification.",
            ]
            return SpeakerVerificationReport(
                provider="fallback",
                similarity_score=round(similarity, 3),
                passed=similarity >= self.threshold,
                threshold=self.threshold,
                notes=notes,
            )

        try:
            classifier = self.__class__._classifier_cache.get("speechbrain_ecapa")
            if classifier is None:
                if self.__class__._speechbrain_unavailable_reason:
                    raise RuntimeError(self.__class__._speechbrain_unavailable_reason)
                classifier = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb")
                self.__class__._classifier_cache["speechbrain_ecapa"] = classifier
            ref_embedding = classifier.encode_batch(self._load_audio_tensor(reference_audio_path, classifier))
            cand_embedding = classifier.encode_batch(self._load_audio_tensor(candidate_audio_path, classifier))
            similarity = torch.nn.functional.cosine_similarity(ref_embedding.squeeze(1), cand_embedding.squeeze(1)).mean().item()
            return SpeakerVerificationReport(
                provider="speechbrain_ecapa",
                similarity_score=round(float(similarity), 3),
                passed=float(similarity) >= self.threshold,
                threshold=self.threshold,
                notes=["Real speaker embedding verification completed with SpeechBrain ECAPA."],
            )
        except Exception as exc:
            if "huggingface.co" in str(exc) or "NameResolutionError" in str(exc) or "MaxRetryError" in str(exc):
                self.__class__._speechbrain_unavailable_reason = f"speechbrain offline/unavailable: {exc}"
            similarity = self._duration_similarity(reference_audio_path, candidate_audio_path)
            return SpeakerVerificationReport(
                provider="fallback",
                similarity_score=round(similarity, 3),
                passed=similarity >= self.threshold,
                threshold=self.threshold,
                notes=[f"SpeechBrain verification failed: {exc}", "Falling back to non-embedding similarity heuristic without retrying remote model download."],
            )

    def _load_audio_tensor(self, audio_path: str, classifier: Any):
        import torchaudio

        waveform, sample_rate = torchaudio.load(audio_path)
        target_rate = getattr(classifier, "sample_rate", sample_rate)
        if sample_rate != target_rate:
            waveform = torchaudio.functional.resample(waveform, sample_rate, target_rate)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        return waveform

    def _duration_similarity(self, reference_audio_path: str, candidate_audio_path: str) -> float:
        reference_duration = self._duration_seconds(reference_audio_path)
        candidate_duration = self._duration_seconds(candidate_audio_path)
        if reference_duration <= 0 or candidate_duration <= 0:
            return 0.35
        ratio = min(reference_duration, candidate_duration) / max(reference_duration, candidate_duration)
        return max(0.35, min(0.8, 0.35 + ratio * 0.45))

    def _duration_seconds(self, audio_path: str) -> float:
        path = Path(audio_path)
        if not path.exists():
            return 0.0
        result = subprocess.run(
            [
                "ffprobe",
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