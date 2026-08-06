from pydantic import BaseModel


class CreateUploadSessionRequest(BaseModel):
    filename: str
    content_type: str = "application/octet-stream"
    size_bytes: int
    name: str = "My Voice"
    transcript_text: str = ""
    srt_offset_ms: int = 0


class UploadSessionResponse(BaseModel):
    upload_id: str
    filename: str
    size_bytes: int
    chunk_size: int
    total_chunks: int
    received_chunks: list[int]
    received_bytes: int
    status: str
    stage: str | None = None
    srt_offset_ms: int = 0
    processing_percent: int = 0
    processing_message: str | None = None
    processing_attempt: int = 0
    accepted_segments: int = 0
    rejected_segments: int = 0
    current_segment_index: int = 0
    total_segments: int = 0
    created_at: str | None = None
    upload_completed_at: str | None = None
    processing_started_at: str | None = None
    processing_completed_at: str | None = None
    processing_elapsed_seconds: float | None = None
    last_updated_at: str | None = None
    error: str | None = None
    voice_profile_id: str | None = None


class CompleteUploadSessionResponse(BaseModel):
    upload_id: str
    status: str
    message: str