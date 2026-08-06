from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db.session import SessionLocal
from app.models.voice_profile import VoiceProfile
from app.services.sanskrit_normalization import SanskritNormalizationService


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a benchmark plan for comparing VoxCPM2 vs adapted voice engines.")
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--benchmarks", default="../../training-data/sanskrit_benchmarks.json")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    db = SessionLocal()
    try:
        profile = db.get(VoiceProfile, args.profile_id)
        if profile is None:
            raise SystemExit("Voice profile not found")
        report = json.loads(profile.readiness_report_json or "{}")
    finally:
        db.close()

    benchmark_path = Path(args.benchmarks)
    payload = json.loads(benchmark_path.read_text(encoding="utf-8"))
    normalizer = SanskritNormalizationService()
    items = []
    for item in payload.get("items", []):
        normalized = normalizer.normalize(str(item.get("text") or ""))
        items.append(
            {
                **item,
                "tts_phonetic_text": normalized.tts_phonetic_text,
                "iast_text": normalized.iast_text,
                "detected_script": normalized.detected_script,
                "engines_to_compare": ["voxcpm2", "chatterbox", "f5_finetuned"],
                "human_rating_fields": ["speaker_identity", "sanskrit_pronunciation", "naturalness", "prosody", "artifacts"],
            }
        )

    result = {
        "status": "ready",
        "voice_profile_id": profile.id,
        "voice_profile_name": profile.name,
        "adapted_models": report.get("adapted_models") or {},
        "items": items,
        "success_rule": "Adapted model must beat VoxCPM2 in blind listening and speaker similarity before becoming default final engine.",
    }
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
