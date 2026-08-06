from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

from app.core.config import get_settings


class AutoTranscriptionService:
    _model_cache: dict[tuple[str, str, str], object] = {}

    def __init__(self) -> None:
        self.settings = get_settings()
        self.ffprobe_path = shutil.which("ffprobe") or "ffprobe"

    def transcribe(self, audio_path: str) -> dict:
        path = Path(audio_path)
        if not path.exists():
            raise ValueError("Audio file not found for transcription")

        whisper_result = self._transcribe_with_faster_whisper(path)
        if whisper_result is not None:
            return whisper_result

        return {
            "provider": "fallback",
            "text": self._fallback_text(path),
            "confidence": 0.35,
            "segments": self._estimate_segments(path),
            "notes": [
                "faster-whisper was unavailable, so a metadata-only fallback transcript was used.",
            ],
        }

    def _transcribe_with_faster_whisper(self, audio_path: Path) -> dict | None:
        try:
            from faster_whisper import WhisperModel
        except Exception:
            return None

        device = self._resolve_device()
        compute_type = self._resolve_compute_type(device)
        try:
            cache_key = (self.settings.asr_model_size, device, compute_type)
            model = self.__class__._model_cache.get(cache_key)
            if model is None:
                model = WhisperModel(self.settings.asr_model_size, device=device, compute_type=compute_type)
                self.__class__._model_cache[cache_key] = model
            segments, info = model.transcribe(str(audio_path), beam_size=self.settings.asr_beam_size)
            collected_segments = list(segments)
        except Exception as exc:
            return {
                "provider": "faster-whisper-fallback",
                "is_measured": False,
                "text": self._fallback_text(audio_path),
                "confidence": 0.25,
                "segments": self._estimate_segments(audio_path),
                "notes": [f"faster-whisper was configured but transcription failed: {exc}"],
            }

        text = " ".join((segment.text or "").strip() for segment in collected_segments).strip()
        language_probability = float(getattr(info, "language_probability", 0.0) or 0.0)
        mean_no_speech = 0.0
        if collected_segments:
            no_speech_scores = [float(getattr(segment, "no_speech_prob", 0.0) or 0.0) for segment in collected_segments]
            mean_no_speech = sum(no_speech_scores) / len(no_speech_scores)

        confidence = max(0.2, min(0.98, (language_probability * 0.7) + ((1.0 - mean_no_speech) * 0.3)))
        segment_payload = [
            {
                "index": index + 1,
                "start_seconds": round(float(segment.start), 2),
                "end_seconds": round(float(segment.end), 2),
                "confidence": round(max(0.05, 1.0 - float(getattr(segment, "no_speech_prob", 0.0) or 0.0)), 3),
                "text": (segment.text or "").strip(),
            }
            for index, segment in enumerate(collected_segments)
        ]

        return {
            "provider": "faster-whisper",
            "is_measured": True,
            "text": text,
            "confidence": round(confidence, 3),
            "segments": segment_payload,
            "language": getattr(info, "language", None),
            "notes": [
                f"Real ASR completed with faster-whisper model '{self.settings.asr_model_size}' on device '{device}'."
            ],
        }

    def _estimate_segments(self, audio_path: Path) -> list[dict]:
        duration_seconds = self._duration_seconds(audio_path)
        if duration_seconds <= 0:
            return []
        segment_count = max(1, int(duration_seconds // 8) or 1)
        segment_length = duration_seconds / segment_count
        return [
            {
                "index": index + 1,
                "start_seconds": round(index * segment_length, 2),
                "end_seconds": round(min(duration_seconds, (index + 1) * segment_length), 2),
                "confidence": 0.35,
            }
            for index in range(segment_count)
        ]

    def _duration_seconds(self, audio_path: Path) -> float:
        try:
            probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(audio_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if probe.stdout.strip():
                return float(probe.stdout.strip())
        except Exception:
            pass
        return 0.0

    def _resolve_device(self) -> str:
        if self.settings.asr_device != "auto":
            return self.settings.asr_device

        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def _resolve_compute_type(self, device: str) -> str:
        if self.settings.asr_compute_type != "auto":
            return self.settings.asr_compute_type
        return "float16" if device == "cuda" else "int8"

    def _fallback_text(self, audio_path: Path) -> str:
        try:
            probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(audio_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            duration = probe.stdout.strip()
            if duration:
                seconds = max(1, int(float(duration)))
                return (
                    "[auto-generated transcript placeholder] "
                    f"Uploaded audio detected with approximate duration {seconds} seconds. "
                    "Install and integrate a real ASR engine like Whisper for accurate transcription."
                )
        except Exception:
            pass

        return (
            "[auto-generated transcript placeholder] Audio was uploaded successfully, "
            "but no real transcription engine is installed yet."
        )