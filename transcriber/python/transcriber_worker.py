#!/usr/bin/env python3
"""Bounded local Whisper transcription worker with a JSON-lines protocol."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from typing import Any, Callable, Iterable


SUPPORTED_MODELS = ("tiny", "base", "small", "medium", "turbo")
DEFAULT_CHUNK_SECONDS = 600
_CANCELLED = False


class CancelledError(RuntimeError):
    """Raised when the worker receives a termination request."""


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def request_cancel(_signum: int | None = None, _frame: Any = None) -> None:
    global _CANCELLED
    _CANCELLED = True


def reset_cancel_state() -> None:
    global _CANCELLED
    _CANCELLED = False


def raise_if_cancelled() -> None:
    if _CANCELLED:
        raise CancelledError("Transcription cancelled")


def format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def normalize_segments(segments: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    previous_end = 0.0
    for segment in segments:
        text = " ".join(str(segment.get("text", "")).split())
        if not text:
            continue
        start = max(previous_end, float(segment.get("start", previous_end)))
        end = max(start, float(segment.get("end", start)))
        normalized.append({"start": start, "end": end, "text": text})
        previous_end = end
    return normalized


def render_srt(segments: Iterable[dict[str, Any]]) -> str:
    entries = []
    for index, segment in enumerate(normalize_segments(segments), start=1):
        entries.append(
            f"{index}\n"
            f"{format_srt_timestamp(segment['start'])} --> {format_srt_timestamp(segment['end'])}\n"
            f"{segment['text']}\n"
        )
    return "\n".join(entries)


def render_transcript(segments: Iterable[dict[str, Any]]) -> str:
    return " ".join(segment["text"] for segment in normalize_segments(segments)).strip()


def choose_device(torch_module: Any) -> str:
    return "cuda" if bool(torch_module.cuda.is_available()) else "cpu"


def probe_duration(input_path: Path, ffprobe: str = "ffprobe") -> float:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    duration = float(result.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Media duration must be greater than zero")
    return duration


def extract_chunk(
    input_path: Path,
    output_path: Path,
    offset_seconds: float,
    duration_seconds: float,
    ffmpeg: str = "ffmpeg",
) -> None:
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(offset_seconds),
            "-t",
            str(duration_seconds),
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(output_path),
        ],
        check=True,
    )


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def transcribe_media(
    input_path: Path,
    output_dir: Path,
    work_dir: Path,
    model_name: str,
    language: str,
    cache_dir: Path,
    chunk_seconds: int = DEFAULT_CHUNK_SECONDS,
    model_loader: Callable[[str, str, Path], Any] | None = None,
    duration_probe: Callable[[Path], float] | None = None,
    chunk_extractor: Callable[[Path, Path, float, float], None] | None = None,
    torch_module: Any | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    if model_name not in SUPPORTED_MODELS:
        raise ValueError(f"Unsupported model: {model_name}")
    if language != "auto" and not (2 <= len(language) <= 3 and language.isalpha() and language.islower()):
        raise ValueError("Language must be 'auto' or a lowercase ISO language code")
    if chunk_seconds <= 0:
        raise ValueError("Chunk duration must be positive")

    input_path = input_path.resolve()
    output_dir = output_dir.resolve()
    work_dir = work_dir.resolve()
    cache_dir = cache_dir.resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Input media not found: {input_path}")

    raise_if_cancelled()
    if torch_module is None:
        import torch as torch_module  # type: ignore[no-redef]
    if model_loader is None:
        import whisper

        def model_loader(name: str, device: str, download_root: Path) -> Any:
            return whisper.load_model(name, device=device, download_root=str(download_root))

    duration_probe = duration_probe or probe_duration
    chunk_extractor = chunk_extractor or extract_chunk
    progress_callback = progress_callback or (lambda _progress: None)

    duration = float(duration_probe(input_path))
    total_chunks = max(1, math.ceil(duration / chunk_seconds))
    device = choose_device(torch_module)
    cache_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    progress_callback({"phase": "loading_model", "percent": 5, "currentChunk": 0, "totalChunks": total_chunks})
    model = model_loader(model_name, device, cache_dir)
    raise_if_cancelled()

    all_segments: list[dict[str, Any]] = []
    for chunk_index in range(total_chunks):
        raise_if_cancelled()
        offset = float(chunk_index * chunk_seconds)
        chunk_duration = min(float(chunk_seconds), duration - offset)
        chunk_path = work_dir / f"chunk-{chunk_index + 1:05}.wav"
        progress_callback(
            {
                "phase": "extracting_audio",
                "percent": round(8 + (chunk_index / total_chunks) * 85, 1),
                "currentChunk": chunk_index + 1,
                "totalChunks": total_chunks,
            }
        )
        try:
            chunk_extractor(input_path, chunk_path, offset, chunk_duration)
            raise_if_cancelled()
            result = model.transcribe(
                str(chunk_path),
                language=None if language == "auto" else language,
                fp16=device == "cuda",
                condition_on_previous_text=False,
                temperature=0,
                verbose=False,
            )
            for segment in result.get("segments", []):
                all_segments.append(
                    {
                        "start": float(segment.get("start", 0)) + offset,
                        "end": float(segment.get("end", 0)) + offset,
                        "text": str(segment.get("text", "")),
                    }
                )
        finally:
            chunk_path.unlink(missing_ok=True)

        progress_callback(
            {
                "phase": "transcribing",
                "percent": round(8 + ((chunk_index + 1) / total_chunks) * 85, 1),
                "currentChunk": chunk_index + 1,
                "totalChunks": total_chunks,
            }
        )

    raise_if_cancelled()
    progress_callback({"phase": "writing_artifacts", "percent": 97, "currentChunk": total_chunks, "totalChunks": total_chunks})
    normalized = normalize_segments(all_segments)
    srt_path = output_dir / "transcript.srt"
    txt_path = output_dir / "transcript.txt"
    write_atomic(srt_path, render_srt(normalized))
    write_atomic(txt_path, render_transcript(normalized))
    progress_callback({"phase": "done", "percent": 100, "currentChunk": total_chunks, "totalChunks": total_chunks})
    return {
        "durationSeconds": duration,
        "device": device,
        "segments": len(normalized),
        "artifacts": {"srt": srt_path.name, "txt": txt_path.name},
    }


def diagnostics(cache_dir: Path) -> dict[str, Any]:
    checks: dict[str, Any] = {
        "python": {
            "ok": (3, 8) <= sys.version_info[:2] <= (3, 12),
            "version": sys.version.split()[0],
            "executable": sys.executable,
        },
        "ffmpeg": {"ok": bool(shutil.which("ffmpeg")), "path": shutil.which("ffmpeg")},
        "ffprobe": {"ok": bool(shutil.which("ffprobe")), "path": shutil.which("ffprobe")},
    }
    device = "unknown"
    try:
        import torch

        device = choose_device(torch)
        checks["torch"] = {"ok": True, "version": getattr(torch, "__version__", "unknown")}
    except Exception as error:  # pragma: no cover - depends on local environment
        checks["torch"] = {"ok": False, "error": str(error)}
    try:
        import whisper

        checks["whisper"] = {"ok": True, "version": getattr(whisper, "__version__", "unknown")}
    except Exception as error:  # pragma: no cover - depends on local environment
        checks["whisper"] = {"ok": False, "error": str(error)}

    ready = all(check.get("ok") for check in checks.values())
    return {"ok": True, "ready": ready, "checks": checks, "device": device, "cacheDir": str(cache_dir.resolve())}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local Whisper transcription worker")
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--work-dir")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--model", choices=SUPPORTED_MODELS, default="small")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--chunk-seconds", type=int, default=DEFAULT_CHUNK_SECONDS)
    return parser


def main(argv: list[str] | None = None) -> int:
    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    args = build_parser().parse_args(argv)
    cache_dir = Path(args.cache_dir)
    if args.diagnostics:
        print(json.dumps(diagnostics(cache_dir), ensure_ascii=False), flush=True)
        return 0
    if not args.input or not args.output_dir or not args.work_dir:
        raise ValueError("--input, --output-dir, and --work-dir are required")

    emit("log", message="Starting local Whisper transcription")
    try:
        result = transcribe_media(
            input_path=Path(args.input),
            output_dir=Path(args.output_dir),
            work_dir=Path(args.work_dir),
            model_name=args.model,
            language=args.language,
            cache_dir=cache_dir,
            chunk_seconds=args.chunk_seconds,
            progress_callback=lambda progress: emit("progress", **progress),
        )
        emit("result", **result)
        return 0
    except CancelledError as error:
        emit("cancelled", message=str(error))
        return 130
    except Exception as error:
        emit("error", message=str(error), errorType=type(error).__name__)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
