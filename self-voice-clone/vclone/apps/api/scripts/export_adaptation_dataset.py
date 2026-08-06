from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db.session import SessionLocal
from app.services.adaptation_dataset import AdaptationDatasetExporter


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a curated voice profile dataset for true speaker adaptation/fine-tuning.")
    parser.add_argument("--profile-id", required=True, help="Voice profile UUID to export.")
    parser.add_argument("--output", required=True, help="Output directory, e.g. ../../training-runs/swami-voice-15")
    parser.add_argument("--min-seconds", type=float, default=2.0)
    parser.add_argument("--max-seconds", type=float, default=18.0)
    parser.add_argument("--speaker-id", default=None)
    parser.add_argument("--no-copy-audio", action="store_true", help="Reference original audio paths instead of copying wavs into the export folder.")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        manifest = AdaptationDatasetExporter(db).export_profile(
            voice_profile_id=args.profile_id,
            output_dir=args.output,
            min_seconds=args.min_seconds,
            max_seconds=args.max_seconds,
            copy_audio=not args.no_copy_audio,
            speaker_id=args.speaker_id,
        )
    finally:
        db.close()

    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    if manifest.get("status") != "ready":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
