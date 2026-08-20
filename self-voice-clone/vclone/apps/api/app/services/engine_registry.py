from __future__ import annotations

from app.core.config import get_settings
from app.services.adapted_engines import F5FinetunedEngine
from app.services.clone_engines import ChatterboxEngine, VoxCPM2Engine
from app.services.tts_engine import BaseTTSEngine, PremiumFinalEngine, XTTSMasteringEngine, XTTSPreviewEngine


class EngineRegistry:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._primary_clone_engine = VoxCPM2Engine()
        self._secondary_clone_engine = ChatterboxEngine()
        self._preview_engine = XTTSPreviewEngine()
        self._final_engine = XTTSMasteringEngine()
        self._premium_final_engine = PremiumFinalEngine()
        self._f5_finetuned_engine = F5FinetunedEngine()

    def get_engine(self, mode: str) -> BaseTTSEngine:
        return self.select(mode, sample_rate_hz=24000, channels=1)["engine"]

    def get_engine_by_name(self, name: str) -> BaseTTSEngine:
        normalized = (name or "").strip().lower()
        mapping: dict[str, BaseTTSEngine] = {
            self._primary_clone_engine.name: self._primary_clone_engine,
            self._secondary_clone_engine.name: self._secondary_clone_engine,
            self._preview_engine.name: self._preview_engine,
            self._final_engine.name: self._final_engine,
            self._premium_final_engine.name: self._premium_final_engine,
            self._f5_finetuned_engine.name: self._f5_finetuned_engine,
            "xtts": self._final_engine,
            "xtts_v2": self._final_engine,
        }
        return mapping.get(normalized, self._select_best_available_engine())

    def describe(self) -> dict:
        return {
            "primary_clone": self._primary_clone_engine.capabilities(),
            "secondary_clone": self._secondary_clone_engine.capabilities(),
            "legacy_preview": self._preview_engine.capabilities(),
            "legacy_final": self._final_engine.capabilities(),
            "premium_final": self._premium_final_engine.capabilities(),
            "adapted_f5": self._f5_finetuned_engine.capabilities(),
        }

    def summary(self) -> dict:
        primary = self._primary_clone_engine.capabilities()
        secondary = self._secondary_clone_engine.capabilities()
        legacy_preview = self._preview_engine.capabilities()
        legacy_final = self._final_engine.capabilities()
        resolved = self._select_best_available_engine()
        return {
            "recommended_preview_engine": resolved.name,
            "recommended_final_engine": resolved.name,
            "primary_engine": primary["name"],
            "secondary_engine": secondary["name"],
            "legacy_fallback_engine": legacy_preview["name"] if legacy_preview["runtime"]["available"] else legacy_final["name"],
            "native_distribution_master_available": bool(resolved.supports_native_distribution_master and resolved.runtime_status()["available"]),
            "final_delivery_warning": "Every published chunk must pass measured ASR, prompt-leak, and 16 kHz speaker-identity gates. Mastering cannot repair a bad clone.",
            "clone_pipeline": "VoxCPM2 reference+transcript cloning with up to three verified takes; Chatterbox bakeoff/fallback; XTTS legacy only.",
            "true_voice_adoption_path": "Export curated dataset, fine-tune F5-TTS/GPT-SoVITS externally, import checkpoint, then benchmark against VoxCPM2.",
        }

    def select(self, mode: str, *, sample_rate_hz: int, channels: int) -> dict:
        normalized_mode = (mode or "final").strip().lower()
        engine = self._select_best_available_engine()
        selection_reason = "best available clone engine selected"
        if engine.name == self._primary_clone_engine.name:
            selection_reason = "VoxCPM2 primary clone engine is available"
        elif engine.name == self._secondary_clone_engine.name:
            selection_reason = "VoxCPM2 unavailable; using Chatterbox clone fallback"
        elif normalized_mode == "preview":
            selection_reason = "modern clone engines unavailable; using legacy XTTS preview fallback"
        else:
            selection_reason = "modern clone engines unavailable; using legacy XTTS final fallback"

        warnings = engine.validate_request(mode=mode, sample_rate_hz=sample_rate_hz, channels=channels)
        if not engine.runtime_status().get("available"):
            warnings.append(engine.runtime_status().get("reason", "Selected engine runtime is unavailable."))
        if engine.name.startswith("xtts"):
            warnings.append("XTTS is now legacy fallback only; it is not recommended for a real final voice clone.")
        rationale = engine.selection_rationale(mode=normalized_mode, sample_rate_hz=sample_rate_hz, channels=channels)
        rationale.append(f"Selection reason: {selection_reason}.")
        return {
            "engine": engine,
            "capabilities": engine.capabilities(),
            "warnings": warnings,
            "selection_reason": selection_reason,
            "rationale": rationale,
        }

    def _select_best_available_engine(self) -> BaseTTSEngine:
        preferred = (self.settings.primary_tts_engine or "voxcpm2").strip().lower()
        engines_by_name: dict[str, BaseTTSEngine] = {
            "voxcpm2": self._primary_clone_engine,
            "chatterbox": self._secondary_clone_engine,
            "xtts": self._final_engine,
            "xtts_v2": self._final_engine,
        }
        ordered_names = [preferred, "voxcpm2", "chatterbox"]
        if self.settings.engine_allow_xtts_fallback:
            ordered_names.extend(["xtts", "xtts_v2"])

        seen: set[str] = set()
        for name in ordered_names:
            if name in seen:
                continue
            seen.add(name)
            engine = engines_by_name.get(name)
            if engine and engine.runtime_status().get("available"):
                return engine

        return engines_by_name.get(preferred) or self._primary_clone_engine
