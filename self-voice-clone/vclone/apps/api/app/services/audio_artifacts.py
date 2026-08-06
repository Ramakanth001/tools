from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import hashlib
import math
import subprocess
import shutil
import wave
from typing import Any, Literal

from app.core.config import get_settings


ArtifactType = Literal["model_candidate", "golden_ref", "asr_16k_copy", "audit_preview"]


@dataclass
class AudioArtifactStats:
    path: str
    exists: bool
    readable: bool
    sample_rate: int | None
    channels: int | None
    frames: int | None
    duration_sec: float | None
    non_silent_duration_sec: float | None
    rms_dbfs: float | None
    peak_dbfs: float | None
    all_zero: bool
    mostly_silent: bool
    has_nan: bool
    has_inf: bool
    sha256: str | None
    format: str | None = None
    subtype: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AudioValidationResult:
    valid: bool
    code: str
    message: str
    artifact_type: ArtifactType
    safe_for_prompt: bool
    stats: AudioArtifactStats
    expected_duration_sec: float | None = None
    actual_duration_sec: float | None = None
    duration_ratio_actual_to_expected: float | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["stats"] = self.stats.to_dict()
        return payload


def _sha256(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inspect_with_soundfile(path: Path) -> AudioArtifactStats | None:
    try:
        import soundfile as sf
    except Exception:
        return None
    try:
        info = sf.info(str(path))
        audio, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:
        return None

    frames = int(audio.shape[0])
    channels = int(audio.shape[1]) if audio.ndim > 1 else 1
    duration_sec = (frames / sample_rate) if sample_rate else None
    flattened = audio.reshape(-1)
    finite = [float(sample) for sample in flattened if math.isfinite(float(sample))]
    has_nan = any(math.isnan(float(sample)) for sample in flattened)
    has_inf = any(math.isinf(float(sample)) for sample in flattened)
    peak = max((abs(sample) for sample in finite), default=0.0)
    rms = math.sqrt(sum(sample * sample for sample in finite) / len(finite)) if finite else 0.0
    peak_dbfs = 20.0 * math.log10(max(peak, 1e-12)) if finite else None
    rms_dbfs = 20.0 * math.log10(max(rms, 1e-12)) if finite else None
    silence_threshold = 10 ** (-55 / 20)
    non_silent_frames = 0
    if sample_rate and channels:
        for frame in audio:
            if max(abs(float(value)) for value in frame) > silence_threshold:
                non_silent_frames += 1
    non_silent_duration = (non_silent_frames / sample_rate) if sample_rate else None
    all_zero = peak <= 1e-8
    mostly_silent = bool(duration_sec and non_silent_duration is not None and non_silent_duration < max(0.05, duration_sec * 0.2))
    return AudioArtifactStats(
        path=str(path),
        exists=True,
        readable=True,
        sample_rate=int(sample_rate) if sample_rate else None,
        channels=channels,
        frames=frames,
        duration_sec=duration_sec,
        non_silent_duration_sec=non_silent_duration,
        rms_dbfs=rms_dbfs,
        peak_dbfs=peak_dbfs,
        all_zero=all_zero,
        mostly_silent=mostly_silent,
        has_nan=has_nan,
        has_inf=has_inf,
        sha256=_sha256(path),
        format=getattr(info, "format", None),
        subtype=getattr(info, "subtype", None),
    )


def _inspect_with_wave(path: Path) -> AudioArtifactStats:
    with wave.open(str(path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        channels = wav_file.getnchannels()
        frames = wav_file.getnframes()
    duration_sec = (frames / sample_rate) if sample_rate else None
    return AudioArtifactStats(
        path=str(path),
        exists=True,
        readable=True,
        sample_rate=sample_rate or None,
        channels=channels or None,
        frames=frames,
        duration_sec=duration_sec,
        non_silent_duration_sec=None,
        rms_dbfs=None,
        peak_dbfs=None,
        all_zero=False,
        mostly_silent=False,
        has_nan=False,
        has_inf=False,
        sha256=_sha256(path),
        format="WAV",
        subtype=None,
    )


def inspect_audio_artifact(path: str | Path) -> AudioArtifactStats:
    artifact_path = Path(path)
    if not artifact_path.exists() or not artifact_path.is_file():
        return AudioArtifactStats(
            path=str(artifact_path),
            exists=False,
            readable=False,
            sample_rate=None,
            channels=None,
            frames=None,
            duration_sec=None,
            non_silent_duration_sec=None,
            rms_dbfs=None,
            peak_dbfs=None,
            all_zero=False,
            mostly_silent=False,
            has_nan=False,
            has_inf=False,
            sha256=None,
        )
    stats = _inspect_with_soundfile(artifact_path)
    if stats is not None:
        return stats
    try:
        return _inspect_with_wave(artifact_path)
    except Exception:
        return AudioArtifactStats(
            path=str(artifact_path),
            exists=True,
            readable=False,
            sample_rate=None,
            channels=None,
            frames=None,
            duration_sec=None,
            non_silent_duration_sec=None,
            rms_dbfs=None,
            peak_dbfs=None,
            all_zero=False,
            mostly_silent=False,
            has_nan=False,
            has_inf=False,
            sha256=_sha256(artifact_path),
        )


def validate_voxcpm_reference_audio(
    path: str | Path,
    *,
    manifest: dict[str, Any] | None = None,
    artifact_type: ArtifactType = "model_candidate",
    expected_duration_sec: float | None = None,
) -> AudioValidationResult:
    settings = get_settings()
    stats = inspect_audio_artifact(path)
    safe_for_prompt = bool((manifest or {}).get("safe_for_prompt", artifact_type in {"model_candidate", "golden_ref"}))
    actual_duration = stats.duration_sec
    ratio = None
    if expected_duration_sec and actual_duration and expected_duration_sec > 0:
        ratio = actual_duration / expected_duration_sec
    if not stats.exists:
        return AudioValidationResult(False, "reference_audio_missing", f"reference_audio_missing: path={path}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if not stats.readable:
        return AudioValidationResult(False, "reference_audio_unreadable", f"reference_audio_unreadable: path={path}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if not stats.sample_rate or stats.sample_rate <= 0:
        return AudioValidationResult(False, "reference_audio_invalid_sample_rate", f"reference_audio_invalid_sample_rate: sample_rate={stats.sample_rate}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if not stats.frames or stats.frames <= 0:
        return AudioValidationResult(False, "reference_audio_empty", f"reference_audio_empty: frames={stats.frames}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if stats.channels not in {1, 2}:
        return AudioValidationResult(False, "reference_audio_invalid_channels", f"reference_audio_invalid_channels: channels={stats.channels}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if stats.has_nan or stats.has_inf:
        return AudioValidationResult(False, "reference_audio_non_finite", f"reference_audio_non_finite: has_nan={stats.has_nan}, has_inf={stats.has_inf}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if stats.all_zero:
        return AudioValidationResult(False, "reference_audio_all_zero", "reference_audio_all_zero", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    if artifact_type in {"model_candidate", "golden_ref"}:
        min_duration = float(settings.voice_prompt_min_seconds)
        max_duration = float(settings.voice_prompt_max_seconds)
        min_non_silent = float(settings.voice_prompt_min_non_silent_seconds)
        tolerance = float(settings.voice_prompt_duration_tolerance_ratio)
        if actual_duration is None:
            return AudioValidationResult(False, "reference_audio_unknown_duration", "reference_audio_unknown_duration", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if actual_duration < min_duration:
            return AudioValidationResult(False, "reference_audio_too_short", f"reference_audio_too_short: duration={actual_duration:.3f}s, min={min_duration:.1f}s", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if actual_duration > max_duration:
            return AudioValidationResult(False, "reference_audio_too_long", f"reference_audio_too_long: duration={actual_duration:.3f}s, max={max_duration:.1f}s", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if stats.non_silent_duration_sec is not None and stats.non_silent_duration_sec < min_non_silent:
            return AudioValidationResult(False, "reference_audio_insufficient_non_silent_audio", f"reference_audio_insufficient_non_silent_audio: non_silent_duration={stats.non_silent_duration_sec:.3f}s, min={min_non_silent:.1f}s", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if ratio is not None and abs(1.0 - ratio) > tolerance:
            return AudioValidationResult(False, "duration_mismatch_extraction_bug", f"duration_mismatch_extraction_bug: expected={expected_duration_sec:.3f}s, actual={actual_duration:.3f}s, ratio={ratio:.3f}", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if not safe_for_prompt:
            return AudioValidationResult(False, "reference_audio_not_safe_for_prompt", "reference_audio_not_safe_for_prompt", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
        if str((manifest or {}).get("artifact_type") or artifact_type) == "audit_preview":
            return AudioValidationResult(False, "reference_audio_wrong_artifact_type", "reference_audio_wrong_artifact_type", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)
    return AudioValidationResult(True, "ok", "ok", artifact_type, safe_for_prompt, stats, expected_duration_sec, actual_duration, ratio)


def ffprobe_duration(path: str | Path) -> float | None:
    probe = shutil.which("ffprobe")
    if probe is None:
        return None
    result = subprocess.run(
        [probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return float((result.stdout or "").strip())
    except Exception:
        return None
