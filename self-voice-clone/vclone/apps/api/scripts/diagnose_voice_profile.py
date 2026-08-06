from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

from app.services.audio_segmenter import AudioSegmenterService
from app.services.srt_parser import SRTParserService


def duration_seconds(path: Path) -> float:
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


def bucket_duration(seconds: float) -> str:
    if seconds < 2:
        return "lt_2s"
    if seconds < 5:
        return "2_5s"
    if seconds < 8:
        return "5_8s"
    if seconds <= 20:
        return "8_20s"
    if seconds <= 30:
        return "20_30s"
    return "gt_30s"


def analyze(args) -> dict:
    wav_path = Path(args.wav)
    srt_path = Path(args.srt)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    srt_result = SRTParserService().parse_text(srt_path.read_text(encoding="utf-8", errors="ignore"))
    shifted_segments = SRTParserService().apply_offset(srt_result.segments, 0)
    buckets: dict[str, int] = {}
    accepted = []
    rejected = []
    for segment in srt_result.segments:
        seconds = segment.duration_ms / 1000.0
        bucket = bucket_duration(seconds)
        buckets[bucket] = buckets.get(bucket, 0) + 1
        payload = segment.to_dict()
        payload["duration_seconds"] = round(seconds, 3)
        payload["duration_bucket"] = bucket
        reason = None
        if seconds < 5:
            reason = "too_short_for_golden_ref"
        elif seconds > 30:
            reason = "too_long_for_golden_ref"
        elif len(segment.text.split()) < 3:
            reason = "too_few_words"
        if reason:
            payload["reason"] = reason
            rejected.append(payload)
        else:
            accepted.append(payload)

    index_29 = next((segment.to_dict() for segment in srt_result.segments if segment.index == 29), None)
    actual_curation = AudioSegmenterService().curate_from_srt(
        audio_path=str(wav_path),
        segments=shifted_segments,
        output_dir=str(out_dir / "curation_artifacts"),
    ).to_dict()
    diagnostics = {
        "wav_path": str(wav_path),
        "srt_path": str(srt_path),
        "raw_audio_duration_seconds": round(duration_seconds(wav_path), 3),
        "srt_entry_count": len(srt_result.segments),
        "srt_covered_seconds": round(sum(segment.duration_ms for segment in srt_result.segments) / 1000.0, 3),
        "duration_buckets": buckets,
        "accepted_prompt_candidate_count": len(accepted),
        "rejected_prompt_candidate_count": len(rejected),
        "accepted_prompt_candidate_seconds": round(sum(item["duration_seconds"] for item in accepted), 3),
        "top_rejection_reasons": top_rejection_reasons(rejected),
        "accepted_examples": accepted[:20],
        "rejected_examples": rejected[:20],
        "actual_curation": {
            "accepted_segment_count": actual_curation.get("accepted_segment_count"),
            "rejected_segment_count": actual_curation.get("rejected_segment_count"),
            "selected_duration_seconds": actual_curation.get("selected_duration_seconds"),
            "coverage_percent": actual_curation.get("coverage_percent"),
            "warnings": actual_curation.get("warnings", [])[:20],
            "selected_segments_preview": (actual_curation.get("selected_segments") or [])[:20],
            "rejected_segments_preview": (actual_curation.get("rejected_segments") or [])[:20],
            "top_rejection_reasons": top_rejection_reasons(list(actual_curation.get("rejected_segments") or [])),
        },
        "srt_index_29": index_29,
        "index_29_note": "Reject for ultimate/Hi-Fi until smoke test proves no prompt leakage." if index_29 else "not_found",
        "prompt_bank_collapse_detected": len(accepted) < 5 or float(actual_curation.get("selected_duration_seconds") or 0.0) < 300.0,
        "srt_warnings": srt_result.warnings[:50],
    }

    (out_dir / "diagnostics.json").write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
    write_jsonl(out_dir / "accepted_candidates.jsonl", accepted)
    write_jsonl(out_dir / "rejected_candidates.jsonl", rejected)
    return diagnostics


def top_rejection_reasons(rejected: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for item in rejected:
        reason = str(item.get("reason") or "unknown")
        counts[reason] = counts.get(reason, 0) + 1
    return [{"reason": reason, "count": count} for reason, count in sorted(counts.items(), key=lambda pair: pair[1], reverse=True)]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose voice-profile prompt candidate coverage without running VoxCPM.")
    parser.add_argument("--wav", required=True)
    parser.add_argument("--srt", required=True)
    parser.add_argument("--out", required=True)
    diagnostics = analyze(parser.parse_args())
    print(json.dumps(diagnostics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())