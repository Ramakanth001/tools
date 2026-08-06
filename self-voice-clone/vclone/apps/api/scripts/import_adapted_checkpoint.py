from __future__ import annotations

import argparse
import json

from app.db.session import SessionLocal
from app.models.voice_profile import VoiceProfile
from app.services.adapted_engines import F5FinetunedEngine, register_adapted_model_in_report


def main() -> None:
    parser = argparse.ArgumentParser(description="Register an externally fine-tuned adapted TTS checkpoint on a voice profile.")
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--engine", default="f5_finetuned", choices=["f5_finetuned"])
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--config", default=None)
    parser.add_argument("--dataset-manifest", default=None)
    parser.add_argument("--notes", default="")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        profile = db.get(VoiceProfile, args.profile_id)
        if profile is None:
            raise SystemExit("Voice profile not found")
        payload = F5FinetunedEngine.registration_payload(
            checkpoint_path=args.checkpoint,
            config_path=args.config,
            dataset_manifest_path=args.dataset_manifest,
            notes=args.notes,
        )
        profile.readiness_report_json = register_adapted_model_in_report(
            profile.readiness_report_json,
            engine=args.engine,
            model_payload=payload,
        )
        db.add(profile)
        db.commit()
        db.refresh(profile)
        print(json.dumps({"status": "registered", "profile_id": profile.id, "model": payload}, indent=2, ensure_ascii=False))
    finally:
        db.close()


if __name__ == "__main__":
    main()
