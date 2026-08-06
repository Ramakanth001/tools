from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
import shutil
import subprocess

from app.services.srt_parser import SRTSegment


@dataclass
class SegmentCurationResult:
    source_audio_path: str
    curated_audio_path: str
    audio_duration_seconds: float
    srt_covered_seconds: float
    coverage_percent: float
    accepted_segment_count: int
    rejected_segment_count: int
    selected_duration_seconds: float
    warnings: list[str]
    selected_segments: list[dict]
    rejected_segments: list[dict]
    ffmpeg_used: bool

    def to_dict(self) -> dict:
        return asdict(self)


class AudioSegmenterService:
    def __init__(self) -> None:
        self.ffmpeg_path = shutil.which("ffmpeg")
        self.ffprobe_path = shutil.which("ffprobe")

    def curate_from_srt(
        self,
        *,
        audio_path: str,
        segments: list[SRTSegment],
        output_dir: str,
        target_seconds: float | None = None,
        max_segments: int | None = None,
        progress_callback=None,
    ) -> SegmentCurationResult:
        source = Path(audio_path)
        target_dir = Path(output_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        curated_path = target_dir / f"srt-curated-{source.stem}.wav"
        work_dir = target_dir / "srt_segments"
        work_dir.mkdir(parents=True, exist_ok=True)

        duration_seconds = self.duration_seconds(source)
        warnings: list[str] = []
        selected: list[dict] = []
        rejected: list[dict] = []
        selected_seconds = 0.0
        covered_seconds = sum(max(0.0, segment.duration_ms / 1000.0) for segment in segments)
        total_segments = len(segments)

        for segment_position, segment in enumerate(segments, start=1):
            if progress_callback:
                progress_callback(
                    {
                        "stage": "srt_silence_detection",
                        "percent": 15 + int((segment_position / max(total_segments, 1)) * 35),
                        "message": f"Analyzing SRT segment {segment_position}/{total_segments}",
                        "current_segment_index": segment_position,
                        "total_segments": total_segments,
                        "accepted_segments": len(selected),
                        "rejected_segments": len(rejected),
                    }
                )
            reason = self._rejection_reason(segment, duration_seconds)
            if reason:
                rejected.append({**segment.to_dict(), "reason": reason})
                continue
            if max_segments is not None and len(selected) >= max_segments:
                warnings.append(f"Stopped SRT analysis after configured max_segments={max_segments}.")
                break
            if target_seconds is not None and selected_seconds >= target_seconds:
                warnings.append(f"Stopped SRT analysis after configured target_seconds={target_seconds}.")
                break
            speech_bounds = self._detect_speech_bounds(source, segment, duration_seconds)
            if not speech_bounds["accepted"]:
                rejected.append({**segment.to_dict(), "reason": speech_bounds["reason"], "speech_analysis": speech_bounds})
                continue

            selected.append({"segment": segment, "speech_analysis": speech_bounds})
            selected_seconds += max(0.0, segment.duration_ms / 1000.0)

        if not selected:
            warnings.append("No usable SRT segments were selected; falling back to full uploaded audio processing.")
            return SegmentCurationResult(
                source_audio_path=str(source),
                curated_audio_path=str(source),
                audio_duration_seconds=duration_seconds,
                srt_covered_seconds=round(covered_seconds, 2),
                coverage_percent=self._coverage_percent(covered_seconds, duration_seconds),
                accepted_segment_count=0,
                rejected_segment_count=len(rejected),
                selected_duration_seconds=0.0,
                warnings=warnings,
                selected_segments=[],
                rejected_segments=rejected[:50],
                ffmpeg_used=False,
            )

        if not self.ffmpeg_path:
            warnings.append("ffmpeg is unavailable; could not extract SRT-aligned speech segments.")
            return SegmentCurationResult(
                source_audio_path=str(source),
                curated_audio_path=str(source),
                audio_duration_seconds=duration_seconds,
                srt_covered_seconds=round(covered_seconds, 2),
                coverage_percent=self._coverage_percent(covered_seconds, duration_seconds),
                accepted_segment_count=len(selected),
                rejected_segment_count=len(rejected),
                selected_duration_seconds=round(selected_seconds, 2),
                warnings=warnings,
                selected_segments=[{**item["segment"].to_dict(), "speech_analysis": item["speech_analysis"]} for item in selected],
                rejected_segments=rejected[:100],
                ffmpeg_used=False,
            )

        segment_files: list[Path] = []
        extracted_segment_reports: list[dict] = []
        for idx, item in enumerate(selected, start=1):
            if progress_callback:
                progress_callback(
                    {
                        "stage": "extracting_speech_segments",
                        "percent": 50 + int((idx / max(len(selected), 1)) * 25),
                        "message": f"Extracting accepted speech segment {idx}/{len(selected)}",
                        "accepted_segments": len(segment_files),
                        "rejected_segments": len(rejected),
                    }
                )
            segment = item["segment"]
            speech_analysis = item["speech_analysis"]
            start = max(0.0, (segment.start_ms / 1000.0) - 0.08)
            end = min(duration_seconds or (segment.end_ms / 1000.0), (segment.end_ms / 1000.0) + 0.12)
            expected_duration = max(0.0, end - start)
            output = work_dir / f"segment_{idx:04d}.wav"
            command = [
                self.ffmpeg_path,
                "-y",
                "-ss",
                f"{start:.3f}",
                "-to",
                f"{end:.3f}",
                "-i",
                str(source),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=11",
                "-ar",
                "24000",
                "-ac",
                "1",
                str(output),
            ]
            try:
                result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=180)
            except subprocess.TimeoutExpired:
                rejected.append({**segment.to_dict(), "reason": "ffmpeg timed out while extracting segment.", "speech_analysis": speech_analysis})
                continue
            if result.returncode == 0 and output.exists() and output.stat().st_size > 44:
                actual_duration = self.duration_seconds(output)
                duration_ratio = (actual_duration / expected_duration) if expected_duration else None
                if actual_duration <= 0 or duration_ratio is None or duration_ratio < 0.75 or duration_ratio > 1.25:
                    rejected.append(
                        {
                            **segment.to_dict(),
                            "reason": "Extracted segment duration did not match SRT window.",
                            "speech_analysis": speech_analysis,
                            "segment_audio_path": str(output),
                            "source_start_sec": start,
                            "source_end_sec": end,
                            "expected_duration_sec": expected_duration,
                            "actual_duration_sec": actual_duration,
                            "duration_ratio_actual_to_expected": duration_ratio,
                        }
                    )
                    continue
                segment_files.append(output)
                extracted_segment_reports.append(
                    {
                        **segment.to_dict(),
                        "speech_analysis": speech_analysis,
                        "segment_audio_path": str(output),
                        "source_start_sec": start,
                        "source_end_sec": end,
                        "expected_duration_sec": expected_duration,
                        "actual_duration_sec": actual_duration,
                        "duration_ratio_actual_to_expected": duration_ratio,
                    }
                )
            else:
                rejected.append({**segment.to_dict(), "reason": "ffmpeg failed to extract segment or extracted silence.", "speech_analysis": speech_analysis})

        if not segment_files:
            warnings.append("All selected SRT segments failed extraction; falling back to full uploaded audio processing.")
            curated_path = source
            ffmpeg_used = False
        else:
            concat_list = work_dir / "concat.txt"
            concat_list.write_text("".join(f"file '{path.name}'\n" for path in segment_files), encoding="utf-8")
            if progress_callback:
                progress_callback({"stage": "concatenating_curated_audio", "percent": 78, "message": "Concatenating curated SRT speech segments."})
            concat_command = [
                self.ffmpeg_path,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                concat_list.name,
                "-ar",
                "24000",
                "-ac",
                "1",
                str(curated_path),
            ]
            result = subprocess.run(concat_command, cwd=str(work_dir), capture_output=True, text=True, check=False, timeout=600)
            if result.returncode != 0 or not curated_path.exists():
                warnings.append("Failed to concatenate extracted SRT segments; falling back to full uploaded audio processing.")
                curated_path = source
                ffmpeg_used = False
            else:
                ffmpeg_used = True

        return SegmentCurationResult(
            source_audio_path=str(source),
            curated_audio_path=str(curated_path),
            audio_duration_seconds=duration_seconds,
            srt_covered_seconds=round(covered_seconds, 2),
            coverage_percent=self._coverage_percent(covered_seconds, duration_seconds),
            accepted_segment_count=len(segment_files) if self.ffmpeg_path else len(selected),
            rejected_segment_count=len(rejected),
            selected_duration_seconds=round(selected_seconds, 2),
            warnings=warnings,
            selected_segments=(
                extracted_segment_reports
                if extracted_segment_reports
                else [{**item["segment"].to_dict(), "speech_analysis": item["speech_analysis"]} for item in selected]
            ),
            rejected_segments=rejected[:100],
            ffmpeg_used=ffmpeg_used,
        )

    def duration_seconds(self, path: Path) -> float:
        if not self.ffprobe_path:
            return 0.0
        result = subprocess.run(
            [self.ffprobe_path, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            try:
                return round(float(result.stdout.strip()), 2)
            except ValueError:
                return 0.0
        return 0.0

    def _rejection_reason(self, segment: SRTSegment, audio_duration_seconds: float) -> str | None:
        duration_seconds = segment.duration_ms / 1000.0
        if duration_seconds < 1.0:
            return "Segment is too short for useful voice conditioning."
        if duration_seconds > 45.0:
            return "Segment is too long; long subtitles are less reliable for alignment."
        if audio_duration_seconds > 0 and segment.start_ms / 1000.0 >= audio_duration_seconds:
            return "Segment starts outside audio duration."
        if len(segment.text.split()) < 2:
            return "Segment text is too short."
        return None

    def _detect_speech_bounds(self, source: Path, segment: SRTSegment, audio_duration_seconds: float) -> dict:
        srt_start = segment.start_ms / 1000.0
        srt_end = segment.end_ms / 1000.0
        window_start = max(0.0, srt_start - 0.15)
        window_end = min(audio_duration_seconds or srt_end + 0.1, srt_end + 0.1)
        window_duration = max(0.0, window_end - window_start)
        fallback = {
            "accepted": True,
            "method": "srt_window_fallback",
            "detected_start_seconds": window_start,
            "detected_end_seconds": window_end,
            "detected_duration_seconds": round(window_duration, 3),
            "trimmed_leading_silence_ms": 0,
            "trimmed_trailing_silence_ms": 0,
            "speech_coverage_percent": 100.0,
            "notes": ["Speech-boundary detection unavailable; using padded SRT window."],
        }

        if not self.ffmpeg_path or window_duration <= 0:
            return fallback

        command = [
            self.ffmpeg_path,
            "-hide_banner",
            "-nostats",
            "-ss",
            f"{window_start:.3f}",
            "-t",
            f"{window_duration:.3f}",
            "-i",
            str(source),
            "-af",
            "silencedetect=noise=-40dB:d=0.20",
            "-f",
            "null",
            "-",
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=45)
        except subprocess.TimeoutExpired:
            fallback["notes"].append("ffmpeg silencedetect timed out; using padded SRT window.")
            return fallback
        if result.returncode != 0:
            fallback["notes"].append("ffmpeg silencedetect failed; using padded SRT window.")
            return fallback

        silences = self._parse_silencedetect(result.stderr, window_duration)
        speech_intervals = self._subtract_silences(window_duration, silences)
        if not speech_intervals:
            return {
                **fallback,
                "accepted": True,
                "method": "silencedetect",
                "reason": None,
                "speech_coverage_percent": 0.0,
                "notes": ["No reliable non-silent interval was detected; falling back to padded SRT window instead of rejecting the segment."],
            }

        relative_start = min(start for start, _ in speech_intervals)
        relative_end = max(end for _, end in speech_intervals)
        detected_duration = max(0.0, relative_end - relative_start)
        speech_total = sum(max(0.0, end - start) for start, end in speech_intervals)
        coverage_percent = round((speech_total / window_duration) * 100.0, 2) if window_duration else 0.0
        word_count = len(segment.text.split())
        min_reasonable = max(0.35, word_count / 7.0)

        if detected_duration < min_reasonable:
            return {
                **fallback,
                "accepted": True,
                "method": "silencedetect",
                "reason": None,
                "detected_start_seconds": round(window_start + relative_start, 3),
                "detected_end_seconds": round(window_start + relative_end, 3),
                "detected_duration_seconds": round(detected_duration, 3),
                "speech_coverage_percent": coverage_percent,
                "notes": ["Detected speech span looked too short after silence trimming; falling back to padded SRT window instead of rejecting the segment."],
            }

        trailing_trim_ms = max(0, round((window_duration - relative_end) * 1000))
        leading_trim_ms = max(0, round(relative_start * 1000))
        notes = []
        if trailing_trim_ms >= 300:
            notes.append(f"Trimmed {trailing_trim_ms} ms of trailing silence/subtitle display time.")
        if leading_trim_ms >= 300:
            notes.append(f"Trimmed {leading_trim_ms} ms of leading silence.")
        if coverage_percent < 35:
            notes.append("SRT window contains substantial silence; only detected speech span will be used.")

        return {
            "accepted": True,
            "method": "silencedetect",
            "detected_start_seconds": round(window_start + relative_start, 3),
            "detected_end_seconds": round(window_start + relative_end, 3),
            "detected_duration_seconds": round(detected_duration, 3),
            "trimmed_leading_silence_ms": leading_trim_ms,
            "trimmed_trailing_silence_ms": trailing_trim_ms,
            "speech_coverage_percent": coverage_percent,
            "notes": notes,
        }

    def _parse_silencedetect(self, stderr: str, window_duration: float) -> list[tuple[float, float]]:
        silences: list[tuple[float, float]] = []
        pending_start: float | None = None
        for line in (stderr or "").splitlines():
            start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
            if start_match:
                pending_start = float(start_match.group(1))
                continue
            end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
            if end_match and pending_start is not None:
                end = float(end_match.group(1))
                silences.append((max(0.0, pending_start), min(window_duration, end)))
                pending_start = None
        if pending_start is not None:
            silences.append((max(0.0, pending_start), window_duration))
        return [(start, end) for start, end in silences if end > start]

    def _subtract_silences(self, duration: float, silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
        intervals = [(0.0, duration)]
        for silence_start, silence_end in sorted(silences):
            next_intervals: list[tuple[float, float]] = []
            for start, end in intervals:
                if silence_end <= start or silence_start >= end:
                    next_intervals.append((start, end))
                    continue
                if silence_start > start:
                    next_intervals.append((start, silence_start))
                if silence_end < end:
                    next_intervals.append((silence_end, end))
            intervals = next_intervals
        return [(start, end) for start, end in intervals if end - start >= 0.08]

    def _coverage_percent(self, covered_seconds: float, duration_seconds: float) -> float:
        if duration_seconds <= 0:
            return 0.0
        return round(min(100.0, (covered_seconds / duration_seconds) * 100.0), 2)