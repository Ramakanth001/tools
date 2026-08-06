from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess


ARCHIVE_FORMATS = {".wav", ".flac", ".aiff", ".aif", ".m4a", ".mp3", ".aac", ".ogg"}


@dataclass
class ProcessedAudioInfo:
    source_path: str
    processed_path: str
    duration_seconds: float
    ffmpeg_used: bool
    silence_trimmed: bool
    loudness_normalized: bool
    warning_level: str
    readiness_status: str
    guidance: str


class AudioProcessingService:
    def __init__(self) -> None:
        self.ffmpeg_path = shutil.which("ffmpeg")
        self.ffprobe_path = shutil.which("ffprobe")

    def process_for_conditioning(self, input_path: str, output_dir: str, preserve_internal_silence: bool = False) -> ProcessedAudioInfo:
        source = Path(input_path)
        target_dir = Path(output_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        processed_path = target_dir / f"processed-{source.stem}.wav"

        ffmpeg_used = False
        silence_trimmed = False
        loudness_normalized = False

        if self.ffmpeg_path:
            audio_filter = "loudnorm=I=-16:TP=-1.5:LRA=11"
            if not preserve_internal_silence:
                audio_filter = (
                    "silenceremove=start_periods=1:start_silence=0.2:start_threshold=-40dB:"
                    "stop_periods=1:stop_silence=0.3:stop_threshold=-40dB,loudnorm=I=-16:TP=-1.5:LRA=11"
                )
            command = [
                self.ffmpeg_path,
                "-y",
                "-i",
                str(source),
                "-af",
                audio_filter,
                "-ar",
                "24000",
                "-ac",
                "1",
                str(processed_path),
            ]
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode == 0 and processed_path.exists():
                ffmpeg_used = True
                silence_trimmed = not preserve_internal_silence
                loudness_normalized = True

        if not processed_path.exists():
            processed_path.write_bytes(source.read_bytes())

        duration = self._duration_seconds(processed_path)
        warning_level, readiness_status, guidance = self._guidance_for_duration(duration)
        return ProcessedAudioInfo(
            source_path=str(source),
            processed_path=str(processed_path),
            duration_seconds=duration,
            ffmpeg_used=ffmpeg_used,
            silence_trimmed=silence_trimmed,
            loudness_normalized=loudness_normalized,
            warning_level=warning_level,
            readiness_status=readiness_status,
            guidance=guidance,
        )

    def _duration_seconds(self, path: Path) -> float:
        if self.ffprobe_path:
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
            if result.returncode == 0:
                try:
                    return round(float(result.stdout.strip()), 2)
                except ValueError:
                    pass
        return 0.0

    def _guidance_for_duration(self, duration_seconds: float) -> tuple[str, str, str]:
        if duration_seconds < 15:
            return (
                "critical",
                "needs_more_audio",
                "Very short reference audio. XTTS inference may still run later, but quality is likely poor. Add more speech if possible.",
            )
        if duration_seconds < 120:
            return (
                "warning",
                "ready_with_warning",
                "Valid short clip. Usable for reference conditioning, but under 2 minutes may reduce stability and similarity.",
            )
        if duration_seconds < 300:
            return (
                "recommendation",
                "ready",
                "Good starting point. This should work, though 5–10+ minutes can further improve conditioning quality.",
            )
        return (
            "good",
            "ready",
            "Strong reference duration for MVP conditioning. This is in the recommended range for better quality.",
        )