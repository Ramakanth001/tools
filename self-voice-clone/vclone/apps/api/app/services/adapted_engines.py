from __future__ import annotations

import json
from pathlib import Path
import shutil

from app.services.sanskrit_normalization import SanskritNormalizationService
from app.services.tts_engine import BaseTTSEngine, XTTSInferenceError


class AdaptedEngineError(XTTSInferenceError):
    pass


class F5FinetunedEngine(BaseTTSEngine):
    """Scaffold for a future speaker-adapted F5-TTS runtime.

    The project can now export/import adapted checkpoints, but F5-TTS itself is
    intentionally not bundled into the FastAPI process.  Once a compatible local
    F5-TTS inference package/checkout is installed, wire `_invoke_f5tts` to that
    version's API/CLI.
    """

    name = "f5_finetuned"
    native_sample_rate_hz = 24000
    native_channels = 1
    quality_tier = "adapted_clone"
    supports_native_distribution_master = False

    def __init__(self) -> None:
        self.sanskrit = SanskritNormalizationService()

    def runtime_status(self) -> dict:
        f5_available = shutil.which("f5-tts_infer-cli") is not None or shutil.which("f5-tts_infer-gradio") is not None
        return {
            "available": f5_available,
            "reason": "F5-TTS CLI is available." if f5_available else "F5-TTS inference CLI is not installed; export/train/import is scaffolded but runtime synthesis is disabled.",
            "dependencies": [
                {"name": "f5-tts_infer-cli", "available": shutil.which("f5-tts_infer-cli") is not None},
                {"name": "ffmpeg", "available": shutil.which("ffmpeg") is not None},
                {"name": "ffprobe", "available": shutil.which("ffprobe") is not None},
            ],
        }

    def capabilities(self) -> dict:
        capabilities = super().capabilities()
        capabilities.update(
            {
                "supports_preview": False,
                "supports_final": True,
                "usage": "speaker_adapted_true_clone_candidate",
                "requires_profile_artifacts": ["adapted_models.f5_finetuned.checkpoint_path", "adapted_models.f5_finetuned.config_path"],
                "training_required": True,
                "sanskrit_strategy": "Use profile Sanskrit normalizer/phonetic romanization before inference.",
                "status": "scaffolded_runtime_pending_f5tts_installation",
            }
        )
        return capabilities

    def selection_rationale(self, *, mode: str, sample_rate_hz: int, channels: int) -> list[str]:
        rationale = super().selection_rationale(mode=mode, sample_rate_hz=sample_rate_hz, channels=channels)
        rationale.append("F5-TTS fine-tuned engine is intended for persistent speaker adaptation rather than prompt-only cloning.")
        return rationale

    def synthesize(
        self,
        text: str,
        voice_profile_id: str,
        mode: str,
        output_path: str,
        speaker_wav: str,
        language: str | None = None,
        prompt_text: str | None = None,
        voice_profile_report: dict | None = None,
        clone_mode: str | None = None,
    ) -> dict:
        report = voice_profile_report or {}
        model_info = ((report.get("adapted_models") or {}).get("f5_finetuned") or {})
        if not model_info:
            raise AdaptedEngineError("No imported F5-TTS adapted checkpoint is registered for this voice profile.")
        checkpoint = Path(str(model_info.get("checkpoint_path") or ""))
        config = Path(str(model_info.get("config_path") or "")) if model_info.get("config_path") else None
        if not checkpoint.exists():
            raise AdaptedEngineError("Registered F5-TTS checkpoint file is missing.")
        if config is not None and not config.exists():
            raise AdaptedEngineError("Registered F5-TTS config file is missing.")
        if not self.runtime_status().get("available"):
            raise AdaptedEngineError(str(self.runtime_status().get("reason")))

        normalized = self.sanskrit.normalize(text).tts_phonetic_text if (language or "").lower().startswith("sa") else text
        raise AdaptedEngineError(
            "F5-TTS runtime invocation is not wired yet. Dataset export/import is ready; install F5-TTS and connect the CLI/API for synthesis. "
            f"Prepared text would be: {normalized[:160]}"
        )

    @staticmethod
    def registration_payload(*, checkpoint_path: str, config_path: str | None, dataset_manifest_path: str | None, notes: str = "") -> dict:
        checkpoint = Path(checkpoint_path)
        config = Path(config_path) if config_path else None
        return {
            "status": "imported",
            "engine": "f5_finetuned",
            "checkpoint_path": str(checkpoint),
            "checkpoint_exists": checkpoint.exists(),
            "config_path": str(config) if config else None,
            "config_exists": config.exists() if config else None,
            "dataset_manifest_path": dataset_manifest_path,
            "notes": notes,
        }


def register_adapted_model_in_report(report_json: str, *, engine: str, model_payload: dict) -> str:
    try:
        report = json.loads(report_json or "{}")
    except Exception:
        report = {}
    adapted = dict(report.get("adapted_models") or {})
    adapted[engine] = model_payload
    report["adapted_models"] = adapted
    report["true_voice_adoption"] = {
        "status": "checkpoint_imported" if model_payload.get("checkpoint_exists") else "checkpoint_registered_missing_file",
        "preferred_engine_candidate": engine,
        "note": "This profile has an adapted-model registration path. Run benchmark comparison before making it the final default.",
    }
    return json.dumps(report, ensure_ascii=False)
