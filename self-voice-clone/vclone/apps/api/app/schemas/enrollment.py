from typing import Literal

from pydantic import BaseModel, Field


class CreateEnrollmentRequest(BaseModel):
    locale: str = Field(..., examples=["en-IN"])
    consent_text_version: str
    intended_use: str = "personal_tts"


class UploadLimits(BaseModel):
    max_files: int
    max_total_minutes: int


class EnrollmentResponse(BaseModel):
    enrollment_id: str
    liveness_phrase: str
    upload_limits: UploadLimits


class PresignAudioRequest(BaseModel):
    filename: str
    content_type: str
    size_bytes: int


class PresignTranscriptRequest(BaseModel):
    filename: str
    type: Literal["srt", "txt", "json"]
    language: str | None = None


class PresignUploadResponse(BaseModel):
    asset_id: str
    upload_url: str
    object_key: str


class ValidateEnrollmentRequest(BaseModel):
    audio_asset_ids: list[str] = []
    transcript_asset_ids: list[str] = []


class JobCreatedResponse(BaseModel):
    job_id: str
    status: str
