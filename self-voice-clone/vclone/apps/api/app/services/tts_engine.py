from __future__ import annotations

from pathlib import Path
import os
import shutil

from app.core.config import get_settings


class XTTSInferenceError(RuntimeError):
    pass


class BaseTTSEngine:
    name = "base"
    native_sample_rate_hz = 24000
    native_channels = 1
    preview_only = False
    quality_tier = "preview"
    supports_native_distribution_master = False

    def runtime_status(self) -> dict:
        return {
            "available": True,
            "reason": "Base engine placeholder is always available.",
            "dependencies": [],
        }

    def capabilities(self) -> dict:
        return {
            "name": self.name,
            "native_sample_rate_hz": self.native_sample_rate_hz,
            "native_channels": self.native_channels,
            "supports_preview": True,
            "supports_final": True,
            "preview_only": self.preview_only,
            "quality_tier": self.quality_tier,
            "supports_native_distribution_master": self.supports_native_distribution_master,
            "runtime": self.runtime_status(),
        }

    def validate_request(self, *, mode: str, sample_rate_hz: int, channels: int) -> list[str]:
        warnings: list[str] = []
        if mode == "final" and self.preview_only:
            warnings.append("Selected engine is preview-only and should not be used for final delivery.")
        if sample_rate_hz > self.native_sample_rate_hz:
            warnings.append("Requested sample rate is above the engine's native render rate; delivery will be derived.")
        if channels > self.native_channels:
            warnings.append("Requested channels exceed the engine's native channel count; delivery will be dual-mono or derived.")
        return warnings

    def selection_rationale(self, *, mode: str, sample_rate_hz: int, channels: int) -> list[str]:
        rationale = [f"Engine '{self.name}' selected for {mode} mode."]
        if self.preview_only:
            rationale.append("This engine is optimized for preview generation rather than release-grade delivery.")
        if sample_rate_hz > self.native_sample_rate_hz:
            rationale.append("Requested sample rate exceeds native render rate, so mastering/export will create a derived delivery file.")
        if channels > self.native_channels:
            rationale.append("Requested channel count exceeds native engine output, so stereo delivery will be packaged from mono output.")
        return rationale


class XTTSv2Engine(BaseTTSEngine):
    name = "xtts_v2"
    _model = None

    def __init__(self):
        self.settings = get_settings()

    def _resolve_device(self) -> str:
        if self.settings.xtts_device != "auto":
            return self.settings.xtts_device

        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def runtime_status(self) -> dict:
        tts_importable = True
        try:
            from TTS.api import TTS  # noqa: F401
        except Exception:
            tts_importable = False

        return {
            "available": tts_importable,
            "reason": "XTTS runtime is importable." if tts_importable else "Coqui TTS is not importable in the current API environment.",
            "dependencies": [
                {"name": "ffmpeg", "available": shutil.which("ffmpeg") is not None},
                {"name": "ffprobe", "available": shutil.which("ffprobe") is not None},
                {"name": "coqui_tts", "available": tts_importable},
            ],
        }

    def _load_model(self):
        if self.__class__._model is not None:
            return self.__class__._model

        os.environ.setdefault("COQUI_TOS_AGREED", "1")

        try:
            import torch.serialization
            from TTS.tts.configs.xtts_config import XttsConfig

            torch.serialization.add_safe_globals([XttsConfig])
        except Exception:
            pass

        try:
            from TTS.api import TTS
        except Exception as exc:
            raise XTTSInferenceError(
                "XTTS dependencies are not installed. Install Coqui TTS in the API environment to enable synthesis."
            ) from exc

        device = self._resolve_device()
        try:
            model = TTS(self.settings.xtts_model_name)
            model.to(device)
        except Exception as exc:
            raise XTTSInferenceError(f"Failed to initialize XTTS v2 model: {exc}") from exc

        self.__class__._model = model
        return model

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
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        if not Path(speaker_wav).exists():
            raise XTTSInferenceError("Reference audio for voice profile was not found")

        model = self._load_model()
        language_code = language or self.settings.xtts_default_language

        try:
            model.tts_to_file(
                text=text,
                speaker_wav=speaker_wav,
                language=language_code,
                file_path=str(output),
                split_sentences=self.settings.xtts_enable_text_splitting,
            )
        except Exception as exc:
            raise XTTSInferenceError(f"XTTS inference failed: {exc}") from exc

        if not output.exists():
            raise XTTSInferenceError("XTTS inference finished without producing an output file")

        return {
            "engine": self.name,
            "engine_capabilities": self.capabilities(),
            "voice_profile_id": voice_profile_id,
            "mode": mode,
            "preview_text": text,
            "output_created": True,
            "device": self._resolve_device(),
            "language": language_code,
            "output_path": str(output),
        }


class XTTSPreviewEngine(XTTSv2Engine):
    name = "xtts_v2_preview"
    preview_only = True
    quality_tier = "preview"

    def capabilities(self) -> dict:
        capabilities = super().capabilities()
        capabilities.update(
            {
                "supports_final": False,
                "supports_preview": True,
                "usage": "preview",
            }
        )
        return capabilities


class XTTSMasteringEngine(XTTSv2Engine):
    name = "xtts_v2_mastering"
    quality_tier = "mastering"

    def capabilities(self) -> dict:
        capabilities = super().capabilities()
        capabilities.update(
            {
                "supports_final": True,
                "supports_preview": True,
                "usage": "final",
                "post_processing": ["chunk_concatenation", "loudnorm_mastering", "delivery_validation"],
                "selection_strategy": "strict-final-xtts",
            }
        )
        return capabilities

    def __init__(self):
        self.settings = get_settings()

    def _resolve_device(self) -> str:
        if self.settings.xtts_device != "auto":
            return self.settings.xtts_device

        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def runtime_status(self) -> dict:
        tts_importable = True
        try:
            from TTS.api import TTS  # noqa: F401
        except Exception:
            tts_importable = False

        return {
            "available": tts_importable,
            "reason": "XTTS runtime is importable." if tts_importable else "Coqui TTS is not importable in the current API environment.",
            "dependencies": [
                {"name": "ffmpeg", "available": shutil.which("ffmpeg") is not None},
                {"name": "ffprobe", "available": shutil.which("ffprobe") is not None},
                {"name": "coqui_tts", "available": tts_importable},
            ],
        }

    def _load_model(self):
        if self.__class__._model is not None:
            return self.__class__._model

        os.environ.setdefault("COQUI_TOS_AGREED", "1")

        try:
            import torch.serialization
            from TTS.tts.configs.xtts_config import XttsConfig

            torch.serialization.add_safe_globals([XttsConfig])
        except Exception:
            pass

        try:
            from TTS.api import TTS
        except Exception as exc:
            raise XTTSInferenceError(
                "XTTS dependencies are not installed. Install Coqui TTS in the API environment to enable real synthesis."
            ) from exc

        device = self._resolve_device()
        try:
            model = TTS(self.settings.xtts_model_name)
            model.to(device)
        except Exception as exc:
            raise XTTSInferenceError(f"Failed to initialize XTTS v2 model: {exc}") from exc

        self.__class__._model = model
        return model

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
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        if not Path(speaker_wav).exists():
            raise XTTSInferenceError("Reference audio for voice profile was not found")

        model = self._load_model()
        language_code = language or self.settings.xtts_default_language

        try:
            model.tts_to_file(
                text=text,
                speaker_wav=speaker_wav,
                language=language_code,
                file_path=str(output),
                split_sentences=self.settings.xtts_enable_text_splitting,
            )
        except Exception as exc:
            raise XTTSInferenceError(f"XTTS inference failed: {exc}") from exc

        if not output.exists():
            raise XTTSInferenceError("XTTS inference finished without producing an output file")

        return {
            "engine": self.name,
            "engine_capabilities": self.capabilities(),
            "voice_profile_id": voice_profile_id,
            "mode": mode,
            "preview_text": text,
            "output_created": True,
            "device": self._resolve_device(),
            "language": language_code,
            "output_path": str(output),
        }


class PremiumFinalEngine(BaseTTSEngine):
    name = "premium_final_xtts_hq"
    native_sample_rate_hz = 24000
    native_channels = 1
    quality_tier = "premium_final"
    supports_native_distribution_master = False

    def __init__(self):
        self.settings = get_settings()

    def capabilities(self) -> dict:
        capabilities = super().capabilities()
        capabilities.update(
            {
                "supports_preview": False,
                "supports_final": True,
                "usage": "final",
                "selection_strategy": "premium-plugin",
                "status": "enabled" if self.settings.premium_engine_enabled else "disabled",
                "post_processing": ["chunk_concatenation", "loudnorm_mastering", "delivery-validation", "hq-final-profile"],
            }
        )
        return capabilities

    def runtime_status(self) -> dict:
        tts_importable = True
        try:
            from TTS.api import TTS  # noqa: F401
        except Exception:
            tts_importable = False

        enabled = self.settings.premium_engine_enabled
        available = enabled and tts_importable
        if not enabled:
            reason = "Premium final engine is disabled in config."
        elif not tts_importable:
            reason = "Premium engine is enabled in config, but Coqui TTS is not importable."
        else:
            reason = "Premium XTTS final engine is enabled and importable."

        return {
            "available": available,
            "reason": reason,
            "dependencies": [
                {"name": "ffmpeg", "available": shutil.which("ffmpeg") is not None},
                {"name": "ffprobe", "available": shutil.which("ffprobe") is not None},
                {"name": "coqui_tts", "available": tts_importable},
                {"name": "premium_engine_enabled", "available": enabled},
            ],
        }

    def validate_request(self, *, mode: str, sample_rate_hz: int, channels: int) -> list[str]:
        warnings = super().validate_request(mode=mode, sample_rate_hz=sample_rate_hz, channels=channels)
        if not self.settings.premium_engine_enabled:
            warnings.append("Premium final engine is disabled in config; registry will normally fall back to the strict final XTTS engine.")
        if sample_rate_hz >= 44100:
            warnings.append("Premium final XTTS profile still renders below 44.1 kHz natively, so high-rate delivery remains derived.")
        return warnings

    def selection_rationale(self, *, mode: str, sample_rate_hz: int, channels: int) -> list[str]:
        rationale = super().selection_rationale(mode=mode, sample_rate_hz=sample_rate_hz, channels=channels)
        rationale.append("Premium final engine uses a stricter XTTS final-render profile with tighter settings for more stable output.")
        return rationale

    def _resolve_device(self) -> str:
        if self.settings.xtts_device != "auto":
            return self.settings.xtts_device

        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def _load_model(self):
        if self.__class__._model is not None:
            return self.__class__._model

        os.environ.setdefault("COQUI_TOS_AGREED", "1")

        try:
            import torch.serialization
            from TTS.tts.configs.xtts_config import XttsConfig

            torch.serialization.add_safe_globals([XttsConfig])
        except Exception:
            pass

        try:
            from TTS.api import TTS
        except Exception as exc:
            raise XTTSInferenceError(
                "XTTS dependencies are not installed. Install Coqui TTS in the API environment to enable premium final synthesis."
            ) from exc

        device = self._resolve_device()
        try:
            model = TTS(self.settings.xtts_model_name)
            model.to(device)
        except Exception as exc:
            raise XTTSInferenceError(f"Failed to initialize premium XTTS final model: {exc}") from exc

        self.__class__._model = model
        return model

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
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        if not Path(speaker_wav).exists():
            raise XTTSInferenceError("Reference audio for voice profile was not found")

        model = self._load_model()
        language_code = language or self.settings.xtts_default_language

        try:
            model.tts_to_file(
                text=text,
                speaker_wav=speaker_wav,
                language=language_code,
                file_path=str(output),
                split_sentences=False,
            )
        except Exception as exc:
            raise XTTSInferenceError(f"Premium XTTS final inference failed: {exc}") from exc

        if not output.exists():
            raise XTTSInferenceError("Premium XTTS final inference finished without producing an output file")

        return {
            "engine": self.name,
            "engine_capabilities": self.capabilities(),
            "voice_profile_id": voice_profile_id,
            "mode": mode,
            "preview_text": text,
            "output_created": True,
            "device": self._resolve_device(),
            "language": language_code,
            "output_path": str(output),
        }
