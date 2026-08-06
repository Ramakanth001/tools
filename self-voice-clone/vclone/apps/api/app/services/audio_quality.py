from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
from typing import Any, Literal
import wave

from app.core.config import get_settings


QualityContext = Literal["source", "generated"]


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _dbfs_from_amplitude(amplitude: float | None) -> float | None:
    if amplitude is None:
        return None
    if amplitude <= 0:
        return -120.0
    return 20.0 * math.log10(max(amplitude, 1e-12))


def _amplitude_from_dbfs(dbfs: float) -> float:
    return 10 ** (dbfs / 20.0)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = _clamp(percentile, 0.0, 1.0) * (len(ordered) - 1)
    lower = int(math.floor(rank))
    upper = int(math.ceil(rank))
    if lower == upper:
        return ordered[lower]
    fraction = rank - lower
    return ordered[lower] + ((ordered[upper] - ordered[lower]) * fraction)


@dataclass
class AudioQualityIssue:
    code: str
    severity: Literal["info", "warning", "error"]
    message: str
    blocking: bool = False
    metric: str | None = None
    value: float | int | str | bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AudioQualityReport:
    path: str
    exists: bool
    readable: bool
    duration_seconds: float | None = None
    sample_rate_hz: int | None = None
    channels: int | None = None
    bits_per_sample: int | None = None
    mean_volume_db: float | None = None
    peak_dbfs: float | None = None
    integrated_lufs: float | None = None
    loudness_range_lu: float | None = None
    true_peak_db: float | None = None
    rms_dbfs: float | None = None
    noise_floor_dbfs: float | None = None
    estimated_snr_db: float | None = None
    clipping_ratio: float | None = None
    silence_ratio: float | None = None
    non_silent_seconds: float | None = None
    active_speech_seconds: float | None = None
    active_speech_ratio: float | None = None
    hard_silence_gap_count: int | None = None
    hard_silence_total_seconds: float | None = None
    long_pause_count: int | None = None
    narrowband_likely: bool | None = None
    upload_allowed: bool = False
    analysis_completed: bool = False
    conditioning_allowed: bool = False
    adaptation_allowed: bool = False
    preview_synthesis_allowed: bool = False
    publish_allowed: bool = False
    quality_tier: Literal["unusable", "weak", "usable", "good"] = "unusable"
    enhancement_recommended: bool = False
    score: float = 0.0
    issues: list[AudioQualityIssue] = field(default_factory=list)

    @property
    def is_blocking(self) -> bool:
        return any(issue.blocking for issue in self.issues)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["issues"] = [issue.to_dict() for issue in self.issues]
        return payload


@dataclass
class _AudioSignalStats:
    duration_seconds: float | None
    sample_rate_hz: int | None
    channels: int | None
    bits_per_sample: int | None
    mean_volume_db: float | None
    peak_dbfs: float | None
    rms_dbfs: float | None
    noise_floor_dbfs: float | None
    estimated_snr_db: float | None
    clipping_ratio: float | None
    silence_ratio: float | None
    non_silent_seconds: float | None
    active_speech_seconds: float | None
    active_speech_ratio: float | None
    hard_silence_gap_count: int | None
    hard_silence_total_seconds: float | None
    long_pause_count: int | None
    narrowband_likely: bool | None


class AudioQualityService:
    HARD_SILENCE_EPSILON = 1e-9
    HARD_SILENCE_MIN_SECONDS = 0.025
    LONG_PAUSE_SECONDS = 0.45
    SILENCE_THRESHOLD_DBFS = -54.0
    ACTIVE_SPEECH_THRESHOLD_DBFS = -40.0
    EFFECTIVE_SILENCE_PEAK_DBFS = -57.0
    LOW_VOLUME_RMS_DBFS = -31.0
    VERY_LOW_VOLUME_RMS_DBFS = -38.0
    NOISY_SNR_DB = 14.0
    MODERATE_CLIPPING_RATIO = 0.01
    SEVERE_CLIPPING_RATIO = 0.08
    HIGH_SILENCE_RATIO = 0.35
    VERY_HIGH_SILENCE_RATIO = 0.7
    LOW_LRA_LU = 3.0
    GOOD_LRA_LU = 4.5
    MIN_PREVIEW_NON_SILENT_SECONDS = 0.8
    MIN_ADAPTATION_NON_SILENT_SECONDS = 12.0
    MIN_PUBLISH_NON_SILENT_SECONDS = 20.0
    NARROWBAND_MAX_SAMPLE_RATE_HZ = 16000

    def __init__(self) -> None:
        self.settings = get_settings()
        self.ffmpeg_path = shutil.which("ffmpeg")
        self.ffprobe_path = shutil.which("ffprobe")
        self.min_conditioning_non_silent_seconds = max(2.5, float(self.settings.voice_prompt_min_non_silent_seconds))

    def inspect(
        self,
        path: str | Path,
        *,
        context: QualityContext = "source",
        target_text: str | None = None,
    ) -> AudioQualityReport:
        audio_path = Path(path)
        report = AudioQualityReport(path=str(audio_path), exists=audio_path.exists(), readable=False)

        if not audio_path.exists() or not audio_path.is_file():
            report.issues.append(
                AudioQualityIssue(
                    code="missing_file",
                    severity="error",
                    blocking=True,
                    message="Audio file is missing.",
                )
            )
            return self._finalize_report(report, context=context)

        metadata = self._probe_metadata(audio_path)
        report.exists = True
        report.readable = bool(metadata.get("readable", False))
        report.duration_seconds = metadata.get("duration_seconds")
        report.sample_rate_hz = metadata.get("sample_rate_hz")
        report.channels = metadata.get("channels")
        report.bits_per_sample = metadata.get("bits_per_sample")

        if not report.readable:
            report.issues.append(
                AudioQualityIssue(
                    code="unreadable_audio",
                    severity="error",
                    blocking=True,
                    message="Audio file could not be decoded or inspected.",
                )
            )
            return self._finalize_report(report, context=context)

        signal_stats = self._signal_stats(audio_path, sample_rate_hz=report.sample_rate_hz)
        if signal_stats is not None:
            report.duration_seconds = signal_stats.duration_seconds or report.duration_seconds
            report.sample_rate_hz = signal_stats.sample_rate_hz or report.sample_rate_hz
            report.channels = signal_stats.channels or report.channels
            report.bits_per_sample = signal_stats.bits_per_sample or report.bits_per_sample
            report.mean_volume_db = signal_stats.mean_volume_db
            report.peak_dbfs = signal_stats.peak_dbfs
            report.rms_dbfs = signal_stats.rms_dbfs
            report.noise_floor_dbfs = signal_stats.noise_floor_dbfs
            report.estimated_snr_db = signal_stats.estimated_snr_db
            report.clipping_ratio = signal_stats.clipping_ratio
            report.silence_ratio = signal_stats.silence_ratio
            report.non_silent_seconds = signal_stats.non_silent_seconds
            report.active_speech_seconds = signal_stats.active_speech_seconds
            report.active_speech_ratio = signal_stats.active_speech_ratio
            report.hard_silence_gap_count = signal_stats.hard_silence_gap_count
            report.hard_silence_total_seconds = signal_stats.hard_silence_total_seconds
            report.long_pause_count = signal_stats.long_pause_count
            report.narrowband_likely = signal_stats.narrowband_likely

        loudness = self._measure_loudness(audio_path)
        report.integrated_lufs = loudness.get("integrated_lufs")
        report.loudness_range_lu = loudness.get("loudness_range_lu")
        report.true_peak_db = loudness.get("true_peak_db")

        self._apply_issues(report, context=context, target_text=target_text)
        return self._finalize_report(report, context=context)

    def compare(self, source: AudioQualityReport, generated: AudioQualityReport) -> dict[str, Any]:
        flags: list[str] = []
        if (generated.hard_silence_gap_count or 0) > (source.hard_silence_gap_count or 0):
            flags.append("generated_has_more_hard_zero_gaps")
        if (generated.long_pause_count or 0) > (source.long_pause_count or 0):
            flags.append("generated_has_more_long_pauses")
        if generated.narrowband_likely and not source.narrowband_likely:
            flags.append("generated_sounds_more_narrowband")
        if (
            generated.loudness_range_lu is not None
            and source.loudness_range_lu is not None
            and generated.loudness_range_lu + 1.0 < source.loudness_range_lu
        ):
            flags.append("generated_has_flatter_dynamics")

        return {
            "source_quality_tier": source.quality_tier,
            "generated_quality_tier": generated.quality_tier,
            "silence_ratio_delta": self._delta(source.silence_ratio, generated.silence_ratio),
            "active_speech_ratio_delta": self._delta(source.active_speech_ratio, generated.active_speech_ratio),
            "hard_silence_gap_delta": self._delta_int(source.hard_silence_gap_count, generated.hard_silence_gap_count),
            "long_pause_delta": self._delta_int(source.long_pause_count, generated.long_pause_count),
            "loudness_delta_lufs": self._delta(source.integrated_lufs, generated.integrated_lufs),
            "loudness_range_delta_lu": self._delta(source.loudness_range_lu, generated.loudness_range_lu),
            "flags": flags,
        }

    def recommend_actions(self, report: AudioQualityReport, *, context: QualityContext = "source") -> list[str]:
        recommendations: list[str] = []
        codes = {issue.code for issue in report.issues}
        if "low_volume" in codes:
            recommendations.append("Increase capture or render gain slightly, but preserve headroom to avoid clipping.")
        if "silence_padding" in codes:
            recommendations.append("Trim long silence padding or shorten inter-chunk pauses to keep long-form output moving naturally.")
        if "hard_zero_gaps" in codes:
            recommendations.append("Use smoother chunk joins or shorter sentence-aware pauses to reduce dead digital-zero gaps.")
        if "narrowband_likely" in codes:
            recommendations.append("Use fuller-bandwidth source audio when possible for more open, natural voice tone.")
        if "clipping_detected" in codes:
            recommendations.append("Reduce clipping at capture time or choose cleaner sections for conditioning and adaptation.")
        if "too_little_non_silent_audio_for_conditioning" in codes:
            recommendations.append("Provide a little more clear non-silent speech so conditioning can use stronger reference context.")
        if "low_loudness_range" in codes and context == "generated":
            recommendations.append("Keep mastering gentle after stitching so dynamics are not flattened into robotic long-form speech.")
        if not recommendations and report.quality_tier == "weak":
            recommendations.append("Use the best non-silent portions you have and expect weaker-but-still-usable preview synthesis.")
        return recommendations

    def _apply_issues(self, report: AudioQualityReport, *, context: QualityContext, target_text: str | None) -> None:
        if report.duration_seconds is not None and report.duration_seconds < 0:
            report.issues.append(
                AudioQualityIssue(
                    code="negative_duration",
                    severity="error",
                    blocking=True,
                    message="Audio duration is invalid.",
                    metric="duration_seconds",
                    value=report.duration_seconds,
                )
            )

        if report.duration_seconds is not None and report.duration_seconds <= 0.0:
            report.issues.append(
                AudioQualityIssue(
                    code="empty_audio",
                    severity="error",
                    blocking=True,
                    message="Audio file is empty.",
                )
            )

        effectively_silent = False
        if report.peak_dbfs is not None:
            effectively_silent = report.peak_dbfs <= self.EFFECTIVE_SILENCE_PEAK_DBFS
        if report.non_silent_seconds is not None and report.non_silent_seconds <= 0.05:
            effectively_silent = True
        if effectively_silent:
            report.issues.append(
                AudioQualityIssue(
                    code="effectively_silent_audio",
                    severity="error",
                    blocking=True,
                    message="Audio is effectively silent or all-zero.",
                )
            )
            return

        if report.non_silent_seconds is not None and report.non_silent_seconds < self.min_conditioning_non_silent_seconds:
            report.issues.append(
                AudioQualityIssue(
                    code="too_little_non_silent_audio_for_conditioning",
                    severity="warning",
                    message="Audio has too little non-silent speech for strong conditioning or adaptation.",
                    metric="non_silent_seconds",
                    value=round(report.non_silent_seconds, 3),
                )
            )

        if report.rms_dbfs is not None and report.rms_dbfs <= self.VERY_LOW_VOLUME_RMS_DBFS:
            report.issues.append(
                AudioQualityIssue(
                    code="low_volume",
                    severity="warning",
                    message="Audio is very low volume but still may be usable.",
                    metric="rms_dbfs",
                    value=round(report.rms_dbfs, 3),
                )
            )
        elif report.rms_dbfs is not None and report.rms_dbfs <= self.LOW_VOLUME_RMS_DBFS:
            report.issues.append(
                AudioQualityIssue(
                    code="low_volume",
                    severity="warning",
                    message="Audio level is somewhat low and may reduce clone quality.",
                    metric="rms_dbfs",
                    value=round(report.rms_dbfs, 3),
                )
            )

        if report.estimated_snr_db is not None and report.estimated_snr_db < self.NOISY_SNR_DB:
            report.issues.append(
                AudioQualityIssue(
                    code="noisy_audio",
                    severity="warning",
                    message="Noise floor appears elevated, so output quality may be limited.",
                    metric="estimated_snr_db",
                    value=round(report.estimated_snr_db, 3),
                )
            )

        if report.clipping_ratio is not None and report.clipping_ratio >= self.MODERATE_CLIPPING_RATIO:
            report.issues.append(
                AudioQualityIssue(
                    code="clipping_detected",
                    severity="warning",
                    message="Moderate clipping was detected, but the audio may still be salvageable.",
                    metric="clipping_ratio",
                    value=round(report.clipping_ratio, 5),
                )
            )

        if report.silence_ratio is not None and report.silence_ratio >= self.HIGH_SILENCE_RATIO:
            report.issues.append(
                AudioQualityIssue(
                    code="silence_padding",
                    severity="warning",
                    message="Audio contains a high amount of silence padding or long pauses.",
                    metric="silence_ratio",
                    value=round(report.silence_ratio, 3),
                )
            )

        if (report.hard_silence_gap_count or 0) > 0:
            report.issues.append(
                AudioQualityIssue(
                    code="hard_zero_gaps",
                    severity="warning",
                    message="Detected exact or near-exact digital-silence gaps that often indicate chunk stitching seams.",
                    metric="hard_silence_gap_count",
                    value=report.hard_silence_gap_count,
                )
            )

        if report.narrowband_likely:
            report.issues.append(
                AudioQualityIssue(
                    code="narrowband_likely",
                    severity="warning",
                    message="Audio likely has narrowband or muffled spectral balance.",
                )
            )

        if report.loudness_range_lu is not None and report.loudness_range_lu < self.LOW_LRA_LU:
            report.issues.append(
                AudioQualityIssue(
                    code="low_loudness_range",
                    severity="warning",
                    message="Dynamics appear flat, which can sound robotic in long-form output.",
                    metric="loudness_range_lu",
                    value=round(report.loudness_range_lu, 3),
                )
            )

        if context == "generated":
            self._apply_generated_duration_checks(report, target_text=target_text)

    def _apply_generated_duration_checks(self, report: AudioQualityReport, *, target_text: str | None) -> None:
        if report.duration_seconds is None or not target_text:
            return
        word_count = len([word for word in target_text.split() if word.strip()])
        if word_count <= 0:
            return
        words_per_second = word_count / max(report.duration_seconds, 1e-6)
        if report.duration_seconds < min(0.25, (word_count * 0.02) + 0.05) or words_per_second > 12.0:
            report.issues.append(
                AudioQualityIssue(
                    code="obviously_invalid_duration",
                    severity="error",
                    blocking=True,
                    message="Generated output duration is obviously invalid for the supplied text.",
                    metric="words_per_second",
                    value=round(words_per_second, 3),
                )
            )
            return
        if words_per_second > 5.8 or words_per_second < 0.45:
            report.issues.append(
                AudioQualityIssue(
                    code="suspicious_duration_ratio",
                    severity="warning",
                    message="Generated speech duration looks suspicious relative to the requested text.",
                    metric="words_per_second",
                    value=round(words_per_second, 3),
                )
            )

    def _finalize_report(self, report: AudioQualityReport, *, context: QualityContext) -> AudioQualityReport:
        report.analysis_completed = report.readable
        report.upload_allowed = report.exists and report.readable

        if report.is_blocking:
            report.conditioning_allowed = False
            report.adaptation_allowed = False
            report.preview_synthesis_allowed = False
            report.publish_allowed = False
            report.quality_tier = "unusable"
            report.enhancement_recommended = True
            report.score = 0.0
            return report

        non_silent_seconds = report.non_silent_seconds or 0.0
        preview_allowed = report.upload_allowed and non_silent_seconds >= self.MIN_PREVIEW_NON_SILENT_SECONDS
        conditioning_allowed = report.upload_allowed and non_silent_seconds >= self.min_conditioning_non_silent_seconds
        adaptation_allowed = (
            conditioning_allowed
            and non_silent_seconds >= self.MIN_ADAPTATION_NON_SILENT_SECONDS
            and (report.clipping_ratio is None or report.clipping_ratio < self.SEVERE_CLIPPING_RATIO)
            and not bool(report.narrowband_likely)
        )

        warning_codes = {issue.code for issue in report.issues if issue.severity == "warning"}
        score = 0.88
        penalties = {
            "low_volume": 0.11,
            "noisy_audio": 0.12,
            "clipping_detected": 0.12,
            "silence_padding": 0.08,
            "hard_zero_gaps": 0.1,
            "narrowband_likely": 0.12,
            "low_loudness_range": 0.08,
            "suspicious_duration_ratio": 0.12,
            "too_little_non_silent_audio_for_conditioning": 0.1,
        }
        for code in warning_codes:
            score -= penalties.get(code, 0.04)
        if not preview_allowed:
            score -= 0.2
        if report.silence_ratio is not None and report.silence_ratio >= self.VERY_HIGH_SILENCE_RATIO:
            score -= 0.08
        report.score = round(_clamp(score, 0.0, 1.0), 3)

        if not preview_allowed:
            report.quality_tier = "unusable"
        elif report.score < 0.6 or not conditioning_allowed:
            report.quality_tier = "weak"
        elif report.score < 0.82:
            report.quality_tier = "usable"
        else:
            report.quality_tier = "good"

        report.conditioning_allowed = conditioning_allowed
        report.preview_synthesis_allowed = preview_allowed
        report.adaptation_allowed = adaptation_allowed and report.quality_tier in {"usable", "good"}
        report.publish_allowed = (
            report.preview_synthesis_allowed
            and report.quality_tier == "good"
            and non_silent_seconds >= self.MIN_PUBLISH_NON_SILENT_SECONDS
            and (report.hard_silence_gap_count or 0) == 0
            and (report.long_pause_count or 0) <= 2
            and (report.loudness_range_lu is None or report.loudness_range_lu >= self.GOOD_LRA_LU)
        )
        if context == "generated" and report.quality_tier == "good" and (report.hard_silence_gap_count or 0) > 0:
            report.publish_allowed = False

        report.enhancement_recommended = bool(report.issues) or report.quality_tier != "good"
        if report.quality_tier == "unusable" and not report.is_blocking:
            report.quality_tier = "weak"
        return report

    def _probe_metadata(self, path: Path) -> dict[str, Any]:
        metadata = {
            "readable": False,
            "duration_seconds": None,
            "sample_rate_hz": None,
            "channels": None,
            "bits_per_sample": None,
        }
        ffprobe_metadata = self._probe_with_ffprobe(path)
        if ffprobe_metadata is not None:
            metadata.update(ffprobe_metadata)
        if path.suffix.lower() == ".wav":
            try:
                with wave.open(str(path), "rb") as wav_file:
                    frame_count = wav_file.getnframes()
                    sample_rate_hz = wav_file.getframerate()
                    metadata["readable"] = True
                    metadata["duration_seconds"] = (frame_count / sample_rate_hz) if sample_rate_hz else metadata["duration_seconds"]
                    metadata["sample_rate_hz"] = sample_rate_hz or metadata["sample_rate_hz"]
                    metadata["channels"] = wav_file.getnchannels() or metadata["channels"]
                    metadata["bits_per_sample"] = wav_file.getsampwidth() * 8 or metadata["bits_per_sample"]
                    return metadata
            except Exception:
                pass
        if metadata["readable"]:
            return metadata
        try:
            import soundfile as sf  # type: ignore

            info = sf.info(str(path))
            metadata["readable"] = True
            metadata["duration_seconds"] = float(getattr(info, "duration", 0.0) or 0.0)
            metadata["sample_rate_hz"] = int(getattr(info, "samplerate", 0) or 0) or metadata["sample_rate_hz"]
            metadata["channels"] = int(getattr(info, "channels", 0) or 0) or metadata["channels"]
            subtype_info = str(getattr(info, "subtype_info", "") or "")
            matched = next((int(token) for token in subtype_info.split() if token.isdigit()), None)
            metadata["bits_per_sample"] = matched or metadata["bits_per_sample"]
        except Exception:
            pass
        return metadata

    def _probe_with_ffprobe(self, path: Path) -> dict[str, Any] | None:
        if not self.ffprobe_path:
            return None
        result = subprocess.run(
            [
                self.ffprobe_path,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-print_format",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None
        try:
            payload = json.loads(result.stdout or "{}")
        except json.JSONDecodeError:
            return None
        streams = payload.get("streams") or []
        audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
        if audio_stream is None:
            return None
        format_payload = payload.get("format") or {}
        return {
            "readable": True,
            "duration_seconds": self._parse_float(audio_stream.get("duration")) or self._parse_float(format_payload.get("duration")),
            "sample_rate_hz": self._parse_int(audio_stream.get("sample_rate")),
            "channels": self._parse_int(audio_stream.get("channels")),
            "bits_per_sample": self._parse_bits_per_sample(audio_stream),
        }

    def _measure_loudness(self, path: Path) -> dict[str, float | None]:
        if not self.ffmpeg_path:
            return {"integrated_lufs": None, "loudness_range_lu": None, "true_peak_db": None}
        result = subprocess.run(
            [
                self.ffmpeg_path,
                "-hide_banner",
                "-i",
                str(path),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        payload = result.stderr or result.stdout or ""
        start = payload.rfind("{")
        end = payload.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return {"integrated_lufs": None, "loudness_range_lu": None, "true_peak_db": None}
        try:
            parsed = json.loads(payload[start : end + 1])
        except json.JSONDecodeError:
            return {"integrated_lufs": None, "loudness_range_lu": None, "true_peak_db": None}
        return {
            "integrated_lufs": self._parse_float(parsed.get("output_i")),
            "loudness_range_lu": self._parse_float(parsed.get("output_lra")),
            "true_peak_db": self._parse_float(parsed.get("output_tp")),
        }

    def _signal_stats(self, path: Path, *, sample_rate_hz: int | None) -> _AudioSignalStats | None:
        if path.suffix.lower() == ".wav":
            try:
                return self._signal_stats_from_wav(path)
            except Exception:
                return None
        try:
            import soundfile as sf  # type: ignore
        except Exception:
            return None
        try:
            audio, detected_sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
        except Exception:
            return None

        frame_count = int(audio.shape[0])
        channels = int(audio.shape[1]) if audio.ndim > 1 else 1
        flat_samples = [float(sample) for row in audio for sample in row]
        frame_levels = [max(abs(float(value)) for value in row) for row in audio]
        narrowband_likely = bool((sample_rate_hz or detected_sample_rate or 0) <= self.NARROWBAND_MAX_SAMPLE_RATE_HZ)
        return self._build_signal_stats(
            flat_samples=flat_samples,
            frame_levels=frame_levels,
            sample_rate_hz=int(detected_sample_rate or sample_rate_hz or 0) or None,
            channels=channels,
            bits_per_sample=None,
            duration_seconds=(frame_count / float(detected_sample_rate)) if detected_sample_rate else None,
            narrowband_likely=narrowband_likely,
        )

    def _signal_stats_from_wav(self, path: Path) -> _AudioSignalStats:
        with wave.open(str(path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_rate_hz = wav_file.getframerate()
            bits_per_sample = wav_file.getsampwidth() * 8
            frame_count = wav_file.getnframes()
            raw = wav_file.readframes(frame_count)
        samples = self._decode_pcm_samples(raw, sample_width_bytes=bits_per_sample // 8)
        frame_levels: list[float] = []
        if channels <= 1:
            frame_levels = [abs(sample) for sample in samples]
        else:
            for index in range(0, len(samples), channels):
                frame = samples[index : index + channels]
                frame_levels.append(max(abs(sample) for sample in frame))
        narrowband_likely = bool(sample_rate_hz <= self.NARROWBAND_MAX_SAMPLE_RATE_HZ)
        return self._build_signal_stats(
            flat_samples=samples,
            frame_levels=frame_levels,
            sample_rate_hz=sample_rate_hz,
            channels=channels,
            bits_per_sample=bits_per_sample,
            duration_seconds=(frame_count / sample_rate_hz) if sample_rate_hz else None,
            narrowband_likely=narrowband_likely,
        )

    def _build_signal_stats(
        self,
        *,
        flat_samples: list[float],
        frame_levels: list[float],
        sample_rate_hz: int | None,
        channels: int | None,
        bits_per_sample: int | None,
        duration_seconds: float | None,
        narrowband_likely: bool | None,
    ) -> _AudioSignalStats:
        if not flat_samples or not frame_levels or not sample_rate_hz:
            return _AudioSignalStats(
                duration_seconds=duration_seconds,
                sample_rate_hz=sample_rate_hz,
                channels=channels,
                bits_per_sample=bits_per_sample,
                mean_volume_db=None,
                peak_dbfs=None,
                rms_dbfs=None,
                noise_floor_dbfs=None,
                estimated_snr_db=None,
                clipping_ratio=None,
                silence_ratio=None,
                non_silent_seconds=None,
                active_speech_seconds=None,
                active_speech_ratio=None,
                hard_silence_gap_count=None,
                hard_silence_total_seconds=None,
                long_pause_count=None,
                narrowband_likely=narrowband_likely,
            )

        abs_samples = [abs(sample) for sample in flat_samples]
        mean_abs = sum(abs_samples) / len(abs_samples)
        mean_volume_db = _dbfs_from_amplitude(mean_abs)
        peak_dbfs = _dbfs_from_amplitude(max(abs_samples, default=0.0))
        rms = math.sqrt(sum(sample * sample for sample in flat_samples) / len(flat_samples)) if flat_samples else 0.0
        rms_dbfs = _dbfs_from_amplitude(rms)
        positive_levels = [level for level in frame_levels if level > 0.0]
        noise_floor_amplitude = _percentile(positive_levels, 0.15)
        noise_floor_dbfs = _dbfs_from_amplitude(noise_floor_amplitude)
        estimated_snr_db = None
        if rms_dbfs is not None and noise_floor_dbfs is not None:
            estimated_snr_db = round(max(0.0, rms_dbfs - noise_floor_dbfs), 3)

        clipping_ratio = sum(1 for sample in abs_samples if sample >= 0.999) / max(len(abs_samples), 1)
        silence_threshold = _amplitude_from_dbfs(self.SILENCE_THRESHOLD_DBFS)
        active_speech_threshold = _amplitude_from_dbfs(self.ACTIVE_SPEECH_THRESHOLD_DBFS)
        silent_frames = sum(1 for level in frame_levels if level <= silence_threshold)
        non_silent_frames = sum(1 for level in frame_levels if level > silence_threshold)
        active_speech_frames = sum(1 for level in frame_levels if level > active_speech_threshold)
        silence_ratio = silent_frames / max(len(frame_levels), 1)
        non_silent_seconds = non_silent_frames / sample_rate_hz
        active_speech_seconds = active_speech_frames / sample_rate_hz
        active_speech_ratio = active_speech_frames / max(len(frame_levels), 1)

        hard_gap_frames = 0
        hard_gap_count = 0
        hard_gap_total_seconds = 0.0
        long_pause_frames = 0
        long_pause_count = 0
        hard_gap_min_frames = max(1, int(self.HARD_SILENCE_MIN_SECONDS * sample_rate_hz))
        long_pause_min_frames = max(1, int(self.LONG_PAUSE_SECONDS * sample_rate_hz))

        for level in frame_levels:
            if level <= self.HARD_SILENCE_EPSILON:
                hard_gap_frames += 1
            else:
                if hard_gap_frames >= hard_gap_min_frames:
                    hard_gap_count += 1
                    hard_gap_total_seconds += hard_gap_frames / sample_rate_hz
                hard_gap_frames = 0

            if level <= silence_threshold:
                long_pause_frames += 1
            else:
                if long_pause_frames >= long_pause_min_frames:
                    long_pause_count += 1
                long_pause_frames = 0

        if hard_gap_frames >= hard_gap_min_frames:
            hard_gap_count += 1
            hard_gap_total_seconds += hard_gap_frames / sample_rate_hz
        if long_pause_frames >= long_pause_min_frames:
            long_pause_count += 1

        return _AudioSignalStats(
            duration_seconds=duration_seconds,
            sample_rate_hz=sample_rate_hz,
            channels=channels,
            bits_per_sample=bits_per_sample,
            mean_volume_db=round(mean_volume_db, 3) if mean_volume_db is not None else None,
            peak_dbfs=round(peak_dbfs, 3) if peak_dbfs is not None else None,
            rms_dbfs=round(rms_dbfs, 3) if rms_dbfs is not None else None,
            noise_floor_dbfs=round(noise_floor_dbfs, 3) if noise_floor_dbfs is not None else None,
            estimated_snr_db=estimated_snr_db,
            clipping_ratio=round(clipping_ratio, 6),
            silence_ratio=round(silence_ratio, 6),
            non_silent_seconds=round(non_silent_seconds, 6),
            active_speech_seconds=round(active_speech_seconds, 6),
            active_speech_ratio=round(active_speech_ratio, 6),
            hard_silence_gap_count=hard_gap_count,
            hard_silence_total_seconds=round(hard_gap_total_seconds, 6),
            long_pause_count=long_pause_count,
            narrowband_likely=narrowband_likely,
        )

    def _decode_pcm_samples(self, raw: bytes, *, sample_width_bytes: int) -> list[float]:
        if sample_width_bytes == 1:
            return [((value - 128) / 128.0) for value in raw]
        if sample_width_bytes == 2:
            count = len(raw) // 2
            return [value / 32768.0 for value in struct.unpack(f"<{count}h", raw)]
        if sample_width_bytes == 3:
            samples: list[float] = []
            for index in range(0, len(raw), 3):
                chunk = raw[index : index + 3]
                if len(chunk) < 3:
                    continue
                sign = b"\xff" if (chunk[2] & 0x80) else b"\x00"
                samples.append(struct.unpack("<i", chunk + sign)[0] / 8388608.0)
            return samples
        if sample_width_bytes == 4:
            count = len(raw) // 4
            return [value / 2147483648.0 for value in struct.unpack(f"<{count}i", raw)]
        raise ValueError(f"Unsupported sample width: {sample_width_bytes}")

    def _parse_int(self, value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _parse_float(self, value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _parse_bits_per_sample(self, stream: dict[str, Any]) -> int | None:
        for key in ("bits_per_raw_sample", "bits_per_sample"):
            parsed = self._parse_int(stream.get(key))
            if parsed:
                return parsed
        sample_fmt = str(stream.get("sample_fmt") or "")
        matched = "".join(token for token in sample_fmt if token.isdigit())
        if matched:
            try:
                return int(matched)
            except ValueError:
                return None
        return None

    def _delta(self, before: float | None, after: float | None) -> float | None:
        if before is None or after is None:
            return None
        return round(after - before, 3)

    def _delta_int(self, before: int | None, after: int | None) -> int | None:
        if before is None or after is None:
            return None
        return after - before