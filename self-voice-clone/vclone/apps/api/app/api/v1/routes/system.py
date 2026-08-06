import os
import json
from pathlib import Path

from fastapi import APIRouter

from app.core.config import get_settings
from app.services.engine_registry import EngineRegistry


router = APIRouter()


@router.get("/capabilities")
def get_system_capabilities() -> dict:
    registry = EngineRegistry()
    return {
        "status": "ok",
        "engines": registry.describe(),
        "summary": registry.summary(),
    }


@router.get("/model-cache")
def get_model_cache_status() -> dict:
    settings = get_settings()
    hf_home = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    return {
        "status": "ok",
        "hf_home": str(hf_home),
        "transformers_cache": os.environ.get("TRANSFORMERS_CACHE"),
        "models": {
            "voxcpm2": {"model": settings.voxcpm_model_name, "cache_hint": "Hugging Face hub cache", "hf_home_exists": hf_home.exists()},
            "chatterbox": {"variant": settings.chatterbox_variant, "cache_hint": "Torch/Hugging Face cache", "hf_home_exists": hf_home.exists()},
            "faster_whisper": {"model": settings.asr_model_size, "cache_hint": "faster-whisper/Hugging Face cache", "hf_home_exists": hf_home.exists()},
        },
        "recommendation": "Set HF_HOME and TRANSFORMERS_CACHE to stable project-local paths and run an explicit smoke/mock test once to warm downloads before real synthesis.",
    }


@router.get("/adaptation/benchmarks")
def get_adaptation_benchmarks() -> dict:
    benchmark_path = Path(__file__).resolve().parents[6] / "training-data" / "sanskrit_benchmarks.json"
    if not benchmark_path.exists():
        return {"status": "missing", "items": [], "path": str(benchmark_path)}
    try:
        payload = json.loads(benchmark_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"status": "error", "items": [], "path": str(benchmark_path), "error": str(exc)}
    return {"status": "ok", "path": str(benchmark_path), **payload}