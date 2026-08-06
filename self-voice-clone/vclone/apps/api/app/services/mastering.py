from __future__ import annotations

from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import wave
from typing import Any

from app.core.config import get_settings


SUPPORTED_DELIVERY_FORMATS = {"wav", "flac"}


@dataclass
class AudioInspection:
    path: str
    container: str
    codec: str | None
    sample_rate_hz: int
    channels: int
    duration_ms: int
    bit_rate: int | None
    bits_per_sample: int | None
    loudness_lufs: float | None = None
    true_peak_db: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AudioMasteringService:
    def __init__(self, *, target_lufs: float | None = None, true_peak_db: float | None = None, target_lra: float | None = None) -> None:
        settings = get_settings()
        self.ffmpeg_path = shutil.which("ffmpeg")
        self.ffprobe_path = shutil.which("ffprobe")
        self.target_lufs = float(settings.delivery_target_lufs if target_lufs is None else target_lufs)
        self.true_peak_db = float(settings.delivery_true_peak_db if true_peak_db is None else true_peak_db)
        self.target_lra = float(settings.delivery_target_lra if target_lra is None else target_lra)

    def normalize_delivery_request(self, audio_format: str, sample_rate_hz: int, channels: int) -> dict[str, int | str]:
        normalized_format = (audio_format or "wav").strip().lower()
        if normalized_format not in SUPPORTED_DELIVERY_FORMATS:
            raise ValueError("Only WAV and FLAC delivery are supported for mastered output")
        if sample_rate_hz < 24000:
            raise ValueError("Requested sample rate must be at least 24000 Hz")
        if channels not in {1, 2}:
            raise ValueError("Only mono or stereo delivery is supported")
        return {
            "format": normalized_format,
            "sample_rate_hz": int(sample_rate_hz),
            "channels": int(channels),
        }

    def inspect_audio(self, input_path: str) -> AudioInspection:
        path = Path(input_path)
        if not path.exists():
            raise ValueError(f"Audio file does not exist: {input_path}")

        if self.ffprobe_path:
            inspected = self._inspect_with_ffprobe(path)
            if inspected is not None:
                measured = self._measure_loudness(path)
                inspected.loudness_lufs = measured.get("integrated_lufs")
                inspected.true_peak_db = measured.get("true_peak_db")
                return inspected

        inspected = self._inspect_with_wave(path)
        measured = self._measure_loudness(path)
        inspected.loudness_lufs = measured.get("integrated_lufs")
        inspected.true_peak_db = measured.get("true_peak_db")
        return inspected

    def concatenate_wav_chunks(self, chunk_paths: list[str], output_path: str) -> dict[str, Any]:
        if not chunk_paths:
            raise ValueError("No chunk audio was generated")

        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        if len(chunk_paths) == 1:
            shutil.copyfile(chunk_paths[0], output)
            return {"method": "copy", "chunk_count": 1}

        if self.ffmpeg_path:
            concat_result = self._concat_with_ffmpeg(chunk_paths, output)
            if concat_result["success"]:
                return {"method": "ffmpeg", "chunk_count": len(chunk_paths)}

        self._concat_with_wave(chunk_paths, output)
        return {"method": "wave", "chunk_count": len(chunk_paths)}

    def master_audio(
        self,
        input_path: str,
        output_path: str,
        *,
        audio_format: str,
        sample_rate_hz: int,
        channels: int,
        apply_mastering: bool = True,
    ) -> dict[str, Any]:
        source = Path(input_path)
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        requested = self.normalize_delivery_request(audio_format, sample_rate_hz, channels)
        source_inspection = self.inspect_audio(str(source))

        ffmpeg_used = False
        if self.ffmpeg_path:
            self._master_with_ffmpeg(
                source,
                output,
                audio_format=str(requested["format"]),
                sample_rate_hz=int(requested["sample_rate_hz"]),
                channels=int(requested["channels"]),
                apply_mastering=apply_mastering,
            )
            ffmpeg_used = True
        else:
            if str(requested["format"]) != "wav":
                raise ValueError("ffmpeg is required to export FLAC output")
            if source_inspection.sample_rate_hz != int(requested["sample_rate_hz"]) or source_inspection.channels != int(requested["channels"]):
                raise ValueError("ffmpeg is required for sample-rate or channel conversion")
            shutil.copyfile(source, output)

        output_inspection = self.inspect_audio(str(output))
        report = self.build_delivery_report(
            source=source_inspection,
            delivery=output_inspection,
            requested_format=str(requested["format"]),
            requested_sample_rate_hz=int(requested["sample_rate_hz"]),
            requested_channels=int(requested["channels"]),
            ffmpeg_used=ffmpeg_used,
            apply_mastering=apply_mastering,
        )
        report["delivery"]["checksum_sha256"] = self.compute_sha256(str(output))
        report["delivery"]["distribution_summary"] = self._distribution_summary(report)
        report["delivery"]["release_grade_summary"] = self._release_grade_summary(report)
        return report

    def build_delivery_report(
        self,
        *,
        source: AudioInspection,
        delivery: AudioInspection,
        requested_format: str,
        requested_sample_rate_hz: int,
        requested_channels: int,
        ffmpeg_used: bool,
        apply_mastering: bool,
    ) -> dict[str, Any]:
        notes: list[str] = []
        stereo_mode = "native"
        if requested_channels == 2 and source.channels == 1:
            stereo_mode = "dual_mono"
            notes.append("Requested stereo delivery was created by duplicating a mono XTTS render; this is not native stereo capture.")
        elif requested_channels == 1:
            stereo_mode = "mono"

        if source.sample_rate_hz < 44100:
            notes.append("The native XTTS render is below 44.1 kHz, so the delivered file is a mastered/up-sampled distribution copy, not a native hi-res master.")
        if source.channels < 2:
            notes.append("The native XTTS render is mono; Spotify prefers a native stereo master when one exists.")
        if delivery.container not in SUPPORTED_DELIVERY_FORMATS:
            notes.append("Delivered container is not in the recommended WAV/FLAC set.")
        if delivery.bits_per_sample is not None and delivery.container == "wav" and delivery.bits_per_sample < 24:
            notes.append("Delivered WAV is below 24-bit depth.")
        if delivery.loudness_lufs is None:
            notes.append("Integrated loudness could not be measured; release validation is incomplete.")
        if delivery.true_peak_db is None:
            notes.append("True peak could not be measured; release validation is incomplete.")

        container_ok = delivery.container in SUPPORTED_DELIVERY_FORMATS and delivery.sample_rate_hz >= 44100 and delivery.channels == 2
        native_master_ok = container_ok and source.sample_rate_hz >= 44100 and source.channels == 2
        loudness_ok = delivery.loudness_lufs is not None and abs(delivery.loudness_lufs - self.target_lufs) <= 2.0
        true_peak_ok = delivery.true_peak_db is not None and delivery.true_peak_db <= self.true_peak_db + 0.3

        status = "not_ready"
        if native_master_ok and loudness_ok and true_peak_ok:
            status = "native_master_ready"
        elif container_ok:
            status = "packaged_but_derived"

        return {
            "requested": {
                "format": requested_format,
                "sample_rate_hz": requested_sample_rate_hz,
                "channels": requested_channels,
            },
            "source": source.to_dict(),
            "delivery": delivery.to_dict(),
            "mastering": {
                "applied": apply_mastering,
                "ffmpeg_used": ffmpeg_used,
                "target_lufs": self.target_lufs,
                "true_peak_db": self.true_peak_db,
                "target_lra": self.target_lra,
                "stereo_mode": stereo_mode,
                "validation": {
                    "sample_rate_matches_request": delivery.sample_rate_hz == requested_sample_rate_hz,
                    "channels_match_request": delivery.channels == requested_channels,
                    "wav_bit_depth_ok": delivery.container != "wav" or (delivery.bits_per_sample or 0) >= 24,
                    "integrated_loudness_ok": loudness_ok,
                    "true_peak_ok": true_peak_ok,
                },
            },
            "spotify": {
                "status": status,
                "delivery_container_ok": container_ok,
                "native_master_ok": native_master_ok,
                "measured_integrated_lufs": delivery.loudness_lufs,
                "measured_true_peak_db": delivery.true_peak_db,
                "notes": notes,
            },
        }

    def _distribution_summary(self, report: dict[str, Any]) -> dict[str, Any]:
        spotify = report["spotify"]
        delivery = report["delivery"]
        mastering = report["mastering"]
        ready = (
            spotify["delivery_container_ok"]
            and mastering["validation"]["sample_rate_matches_request"]
            and mastering["validation"]["channels_match_request"]
            and mastering["validation"]["wav_bit_depth_ok"]
            and mastering["validation"]["integrated_loudness_ok"]
            and mastering["validation"]["true_peak_ok"]
        )
        return {
            "distribution_ready": ready,
            "native_master_ready": spotify["native_master_ok"],
            "derived_master": spotify["status"] == "packaged_but_derived",
            "delivery_sample_rate_hz": delivery["sample_rate_hz"],
            "delivery_channels": delivery["channels"],
        }

    def _release_grade_summary(self, report: dict[str, Any]) -> dict[str, Any]:
        delivery = report["delivery"]
        mastering = report["mastering"]
        spotify = report["spotify"]
        qc_score = 0.0
        qc_score += 0.3 if mastering["validation"]["sample_rate_matches_request"] else 0.0
        qc_score += 0.15 if mastering["validation"]["channels_match_request"] else 0.0
        qc_score += 0.15 if mastering["validation"]["wav_bit_depth_ok"] else 0.0
        qc_score += 0.2 if mastering["validation"]["integrated_loudness_ok"] else 0.0
        qc_score += 0.1 if mastering["validation"]["true_peak_ok"] else 0.0
        qc_score += 0.1 if spotify["delivery_container_ok"] else 0.0

        return {
            "release_grade_score": round(qc_score, 3),
            "release_grade_label": "release_candidate" if qc_score >= 0.8 else "needs_review",
            "target_platform": "spotify_style_delivery",
            "truthfulness": "native" if spotify["native_master_ok"] else "derived",
            "bit_depth_hint": delivery.get("bits_per_sample"),
            "measured_integrated_lufs": delivery.get("loudness_lufs"),
            "measured_true_peak_db": delivery.get("true_peak_db"),
        }

    def _measure_loudness(self, path: Path) -> dict[str, float | None]:
        if not self.ffmpeg_path:
            return {"integrated_lufs": None, "true_peak_db": None}

        result = subprocess.run(
            [
                self.ffmpeg_path,
                "-hide_banner",
                "-i",
                str(path),
                "-af",
                f"loudnorm=I={self.target_lufs}:TP={self.true_peak_db}:LRA={self.target_lra}:print_format=json",
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
            return {"integrated_lufs": None, "true_peak_db": None}
        try:
            loudness_payload = json.loads(payload[start : end + 1])
        except json.JSONDecodeError:
            return {"integrated_lufs": None, "true_peak_db": None}

        return {
            "integrated_lufs": self._parse_float(loudness_payload.get("output_i")),
            "true_peak_db": self._parse_float(loudness_payload.get("output_tp")),
        }

    def compute_sha256(self, input_path: str) -> str:
        digest = sha256()
        with Path(input_path).open("rb") as file_handle:
            for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _inspect_with_ffprobe(self, path: Path) -> AudioInspection | None:
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
        bits_per_sample = self._parse_bits_per_sample(audio_stream)
        duration_seconds = self._parse_float(audio_stream.get("duration")) or self._parse_float(format_payload.get("duration")) or 0.0

        return AudioInspection(
            path=str(path),
            container=path.suffix.lstrip(".").lower() or self._normalize_container_name(format_payload.get("format_name")),
            codec=audio_stream.get("codec_name"),
            sample_rate_hz=int(audio_stream.get("sample_rate") or 0),
            channels=int(audio_stream.get("channels") or 0),
            duration_ms=max(int(duration_seconds * 1000), 0),
            bit_rate=self._parse_int(audio_stream.get("bit_rate")) or self._parse_int(format_payload.get("bit_rate")),
            bits_per_sample=bits_per_sample,
        )

    def _inspect_with_wave(self, path: Path) -> AudioInspection:
        if path.suffix.lower() != ".wav":
            raise ValueError("ffprobe is required to inspect non-WAV audio files")

        with wave.open(str(path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_rate_hz = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            bits_per_sample = wav_file.getsampwidth() * 8
            duration_ms = int((frame_count / sample_rate_hz) * 1000) if sample_rate_hz else 0

        bit_rate = channels * sample_rate_hz * bits_per_sample if sample_rate_hz and bits_per_sample else None
        return AudioInspection(
            path=str(path),
            container="wav",
            codec="pcm",
            sample_rate_hz=sample_rate_hz,
            channels=channels,
            duration_ms=duration_ms,
            bit_rate=bit_rate,
            bits_per_sample=bits_per_sample,
        )

    def _concat_with_ffmpeg(self, chunk_paths: list[str], output_path: Path) -> dict[str, Any]:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as file_list:
            temp_list_path = Path(file_list.name)
            for chunk_path in chunk_paths:
                escaped = Path(chunk_path).resolve().as_posix().replace("'", "'\\''")
                file_list.write(f"file '{escaped}'\n")

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
                    str(temp_list_path),
                    "-c",
                    "copy",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            return {"success": result.returncode == 0 and output_path.exists(), "stderr": result.stderr}
        finally:
            temp_list_path.unlink(missing_ok=True)

    def _concat_with_wave(self, chunk_paths: list[str], output_path: Path) -> None:
        params = None
        with wave.open(str(output_path), "wb") as merged_file:
            for chunk_path in chunk_paths:
                with wave.open(str(chunk_path), "rb") as chunk_file:
                    current_params = chunk_file.getparams()
                    if params is None:
                        params = current_params
                        merged_file.setparams(current_params)
                    elif current_params[:4] != params[:4]:
                        raise ValueError("Generated chunk audio is inconsistent and cannot be concatenated safely")
                    merged_file.writeframes(chunk_file.readframes(chunk_file.getnframes()))

    def _master_with_ffmpeg(
        self,
        source: Path,
        output: Path,
        *,
        audio_format: str,
        sample_rate_hz: int,
        channels: int,
        apply_mastering: bool,
    ) -> None:
        command = [self.ffmpeg_path, "-y", "-i", str(source)]

        filters: list[str] = []
        if apply_mastering:
            filters.append(f"loudnorm=I={self.target_lufs}:TP={self.true_peak_db}:LRA={self.target_lra}")

        if filters:
            command.extend(["-af", ",".join(filters)])

        command.extend(["-ar", str(sample_rate_hz), "-ac", str(channels)])

        if audio_format == "wav":
            command.extend(["-c:a", "pcm_s24le"])
        else:
            command.extend(["-c:a", "flac", "-sample_fmt", "s32"])

        command.append(str(output))

        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0 or not output.exists():
            raise ValueError(f"Failed to master synthesized audio: {result.stderr.strip() or result.stdout.strip() or 'unknown ffmpeg error'}")

    def _normalize_container_name(self, format_names: str | None) -> str:
        if not format_names:
            return "unknown"
        return str(format_names).split(",")[0].strip().lower()

    def _parse_bits_per_sample(self, audio_stream: dict[str, Any]) -> int | None:
        for key in ("bits_per_raw_sample", "bits_per_sample"):
            parsed = self._parse_int(audio_stream.get(key))
            if parsed:
                return parsed

        sample_fmt = str(audio_stream.get("sample_fmt") or "").lower()
        if not sample_fmt:
            return None

        matched = re.search(r"(\d+)", sample_fmt)
        if matched:
            return int(matched.group(1))

        return {
            "u8": 8,
            "s8": 8,
            "s16": 16,
            "s16p": 16,
            "s24": 24,
            "s24p": 24,
            "s32": 32,
            "s32p": 32,
            "flt": 32,
            "fltp": 32,
            "dbl": 64,
            "dblp": 64,
        }.get(sample_fmt)

    def _parse_int(self, value: Any) -> int | None:
        try:
            parsed = int(value)
            return parsed if parsed > 0 else None
        except (TypeError, ValueError):
            return None

    def _parse_float(self, value: Any) -> float | None:
        try:
            parsed = float(value)
            return parsed
        except (TypeError, ValueError):
            return None