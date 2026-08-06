from typing import Any

from pydantic import BaseModel, Field


class SynthesisRequest(BaseModel):
    voice_profile_id: str
    text: str = Field(..., min_length=1)
    mode: str = "preview"
    format: str = "wav"
    sample_rate_hz: int = 24000
    channels: int = 1
    locale: str = "en-IN"
    require_native_master: bool = False


class SynthesisJobResponse(BaseModel):
    job_id: str
    status: str
    message: str | None = None


class SmokeTestRequest(BaseModel):
    voice_profile_id: str
    mode: str = "preview"
    engine_name: str = "voxcpm2"
    candidate_limit: int | None = None


class SmokeTestJobResponse(BaseModel):
    job_id: str
    status: str
    message: str | None = None


class SmokeTestStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: dict[str, Any] = Field(default_factory=dict)
    results: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class SynthesisPreviewResponse(BaseModel):
    job_id: str
    status: str
    preview_text: str
    chunks: list[str]
    request: dict[str, Any]
    created_at: str | None = None
    updated_at: str | None = None
    synthesis_started_at: str | None = None
    synthesis_completed_at: str | None = None
    synthesis_elapsed_seconds: float | None = None


class SynthesizedAssetInfo(BaseModel):
    format: str
    sample_rate_hz: int
    channels: int
    duration_ms: int
    local_path: str
    checksum_sha256: str


class DownloadUrlResponse(BaseModel):
    url: str
    expires_in_seconds: int
    asset: SynthesizedAssetInfo
    delivery_report: dict[str, Any] = Field(default_factory=dict)
    audio_quality: dict[str, Any] = Field(default_factory=dict)
    evaluation: dict[str, Any] = Field(default_factory=dict)
    asr_backcheck: dict[str, Any] = Field(default_factory=dict)
    clone_profile: dict[str, Any] = Field(default_factory=dict)
    candidate_plan: list[dict[str, Any]] = Field(default_factory=list)
    qualified_candidates: list[dict[str, Any]] = Field(default_factory=list)
    smoke_test_failures: list[dict[str, Any]] = Field(default_factory=list)
    candidate_selections: list[dict[str, Any]] = Field(default_factory=list)
    failed_chunks: list[dict[str, Any]] = Field(default_factory=list)
    partial_output: bool = False
    progress_manifest_path: str | None = None
    synthesis_started_at: str | None = None
    synthesis_completed_at: str | None = None
    synthesis_elapsed_seconds: float | None = None
    engine_selection: dict[str, Any] = Field(default_factory=dict)
    engine_registry: dict[str, Any] = Field(default_factory=dict)
