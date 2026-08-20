from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "vclone-api"  # Human-readable API/service name used in responses and docs.
    app_version: str = "0.1.0"  # Current API version string.
    api_v1_prefix: str = "/v1"  # Base prefix for versioned HTTP routes.
    database_url: str = "sqlite:///./vclone.db"  # SQLAlchemy connection string for the app database.
    signed_url_ttl_seconds: int = 3600  # Download URL lifetime for generated assets in seconds.

    upload_chunk_size_bytes: int = 8 * 1024 * 1024  # Browser resumable-upload chunk size.
    upload_max_size_bytes: int = 10 * 1024 * 1024 * 1024  # Maximum accepted upload size for local MVP storage.

    xtts_model_name: str = "tts_models/multilingual/multi-dataset/xtts_v2"  # Coqui TTS model identifier used for XTTS inference.
    xtts_device: str = "auto"  # Inference device: auto/cpu/cuda.
    xtts_default_language: str = "en"  # Default XTTS language code when locale is not provided.
    xtts_temperature: float = 0.7  # General XTTS sampling temperature for balanced generation.
    xtts_enable_text_splitting: bool = True  # Allow XTTS internal sentence splitting during synthesis.
    xtts_final_temperature: float = 0.55  # Lower-temperature target intended for more stable final renders.
    xtts_preview_temperature: float = 0.75  # Higher-temperature target intended for faster/more flexible previews.

    asr_model_size: str = "small"  # faster-whisper model size for transcription/back-check.
    asr_device: str = "auto"  # ASR inference device: auto/cpu/cuda.
    asr_compute_type: str = "auto"  # faster-whisper compute type: auto/int8/float16/etc.
    asr_beam_size: int = 5  # Beam size for transcription decoding quality.

    engine_prefer_premium_final: bool = True  # Prefer the premium final engine path when enabled.
    premium_engine_enabled: bool = False  # Master flag to allow premium final engine selection.
    premium_engine_name: str = "premium_final_placeholder"  # Friendly label/config slot for the premium final engine.
    fail_on_derived_final_master: bool = False  # Personal renders should export mastered audio; use require_native_master for strict fail-closed delivery.

    delivery_default_format: str = "flac"  # Default download format for final delivery.
    delivery_default_sample_rate_hz: int = 48000  # Default requested output sample rate.
    delivery_default_channels: int = 2  # Default requested output channel count.
    delivery_target_lufs: float = -16.0  # Loudness normalization target in LUFS.
    delivery_true_peak_db: float = -1.5  # True-peak ceiling in dBTP.
    delivery_target_lra: float = 9.0  # Slightly gentler loudness-range target to avoid flattening long-form speech dynamics.

    primary_tts_engine: str = "voxcpm2"  # Preferred free local engine for best clone quality.
    engine_allow_xtts_fallback: bool = False  # Do not silently fall back to XTTS because it produced poor clone quality.
    synthesis_max_chunk_chars: int = 320  # Prefer sentence/paragraph-level chunks so prosody has enough context.

    voxcpm_model_name: str = "openbmb/VoxCPM2"  # VoxCPM2 HF/model identifier.
    voxcpm_device: str = "cpu"  # auto/cpu/cuda/mps for VoxCPM2 when supported by runtime.
    voxcpm_allow_cpu: bool = True  # Allow CPU fallback; Mac M-series users may accept slow primary-engine inference.
    voxcpm_load_denoiser: bool = False  # Upstream quickstart default; faster and less processing.
    voxcpm_cfg_value: float = 2.0  # Upstream recommended CFG value.
    voxcpm_inference_timesteps: int = 10  # Upstream quickstart default.
    voxcpm_optimize: bool = False  # Stability first; avoid VoxCPM warm-up/compile path unless explicitly enabled.
    voxcpm_enable_ultimate: bool = True  # Prefer audio + exact-transcript cloning; generated takes still have to pass prompt-leak, ASR, and speaker gates.
    synthesis_chunk_timeout_seconds: int = 900  # User-facing timeout guidance for long model calls.
    synthesis_single_chunk_timeout_seconds: int = 900  # Timeout applied to one isolated generated chunk.
    synthesis_resume_existing_chunks: bool = True  # Reuse already-rendered chunk WAVs when retrying a failed/partial job.
    synthesis_allow_partial_output: bool = True  # Master/stitch completed chunks even if later chunks timeout.
    synthesis_enable_smoke_tests: bool = False  # Keep slow candidate smoke tests out of normal synthesis; run them via diagnostics UI instead.
    synthesis_smoke_test_candidate_limit: int = 1  # If normal-path smoke tests are explicitly enabled, keep them bounded.
    synthesis_diagnostic_candidate_limit: int = 3  # Number of prompt candidates tested by the explicit smoke/mock diagnostic UI.
    synthesis_long_text_chunk_threshold: int = 8  # Use long-form settings when text splits into at least this many chunks.
    synthesis_long_text_chunk_chars: int = 420  # Larger chunks reduce CPU VoxCPM orchestration overhead and preserve sentence flow.
    synthesis_long_text_candidate_limit: int = 1  # Long CPU VoxCPM jobs lock one reference candidate to avoid bakeoff blowups.
    synthesis_heartbeat_interval_seconds: int = 5  # Progress heartbeat while isolated synthesis worker is running.
    synthesis_stale_seconds: int = 180  # Mark running jobs failed when no heartbeat/update arrives in this window.

    chatterbox_device: str = "auto"  # auto/cpu/cuda for Chatterbox.
    chatterbox_variant: str = "original"  # original is the stable pip API; turbo is used only when explicitly installed/supported.
    chatterbox_language_id: str = "en"  # Used by multilingual Chatterbox.

    voice_dataset_min_segment_seconds: float = 2.0  # Hard minimum for clone dataset clips.
    voice_dataset_max_segment_seconds: float = 20.0  # Hard maximum for stable clone dataset clips.
    voice_prompt_target_seconds: int = 20  # Exact prompt pack size for VoxCPM2 ultimate cloning.
    voice_prompt_candidate_count: int = 16  # Number of prompt-bank candidates to keep from enrollment.
    voice_prompt_min_seconds: float = 5.0  # Minimum safe prompt/reference duration for VoxCPM candidate audio.
    voice_prompt_max_seconds: float = 30.0  # Maximum safe prompt/reference duration for VoxCPM candidate audio.
    voice_prompt_min_non_silent_seconds: float = 3.0  # Minimum non-silent speech required in a prompt candidate.
    voice_prompt_duration_tolerance_ratio: float = 0.15  # Reject candidates whose actual duration drifts too far from expected extraction duration.
    voice_dataset_validate_with_asr: bool = True  # Validate curated segments against ASR when possible.
    voice_dataset_asr_validation_max_segments: int = 24  # Cap blocking per-segment ASR during enrollment; larger SRT jobs defer the rest.
    voice_dataset_max_segment_wer: float = 0.35  # Reject segments whose ASR diverges too much from cleaned transcript.
    voice_dataset_hard_reject_with_asr: bool = False  # ASR on short accented segments can be noisy; score by default rather than hard reject.
    voice_dataset_hard_reject_min_confidence: float = 0.75  # Only hard-reject ASR mismatch when the ASR itself is confident.

    synthesis_preview_candidate_limit: int = 3  # Number of prompt/strategy candidates to try for preview selection.
    synthesis_final_candidate_limit: int = 2  # Number of prompt/strategy candidates to try for final selection.
    synthesis_candidate_max_wer: float = 0.45  # Threshold beyond which a candidate is considered poor text fidelity.
    synthesis_similarity_hard_gate: bool = True  # Never publish a fluent generic TTS take as a clone when measured speaker embeddings disagree.
    synthesis_min_speaker_similarity: float = 0.72  # SpeechBrain ECAPA threshold used for measured cross-content speaker verification.
    synthesis_candidate_attempts: int = 3  # VoxCPM2 is stochastic; generate up to the upstream-recommended three takes and keep only a verified clone.
    synthesis_identity_early_stop: float = 0.76  # Stop retrying once a take clears this measured speaker-similarity score and all other gates.
    synthesis_enable_chatterbox_bakeoff: bool = False  # Keep preview stable; only compare Chatterbox when explicitly enabled.
    synthesis_pause_paragraph_ms: int = 260  # Keep paragraph breath, but avoid audible chunk-joint gaps.
    synthesis_pause_sentence_ms: int = 120  # Short natural breath; generated audio often already contains sentence-final silence.
    synthesis_pause_clause_ms: int = 40  # Clause joins should feel continuous, not like separate clips.
    synthesis_pause_default_ms: int = 20  # Default inter-chunk cushion when text gives no better hint.
    synthesis_chunk_fade_ms: int = 10  # Tiny edge fades reduce hard cuts at chunk boundaries.
    synthesis_chunk_crossfade_ms: int = 35  # Overlap adjacent chunks to hide clip boundaries where possible.
    synthesis_trim_edge_silence_ms: int = 300  # Remove generated edge silence before stitching to avoid double-pauses.
    synthesis_trim_edge_silence_threshold_dbfs: float = -54.0  # Conservative trim threshold for near-digital-silence edges.

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
