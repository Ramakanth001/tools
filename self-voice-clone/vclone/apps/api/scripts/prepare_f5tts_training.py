from __future__ import annotations

import argparse
import json

from app.services.adaptation_dataset import AdaptationDatasetExporter


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare an exported adaptation dataset in a simple F5-TTS-friendly layout.")
    parser.add_argument("--dataset", required=True, help="Path to exported dataset directory containing metadata.jsonl and wavs/.")
    parser.add_argument("--output", default=None, help="Optional F5-TTS output directory. Defaults to DATASET/f5tts.")
    args = parser.parse_args()

    result = AdaptationDatasetExporter().prepare_f5tts_layout(dataset_dir=args.dataset, output_dir=args.output)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
