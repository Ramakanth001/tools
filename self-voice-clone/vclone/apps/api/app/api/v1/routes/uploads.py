from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from app.schemas.upload import CompleteUploadSessionResponse, CreateUploadSessionRequest, UploadSessionResponse
from app.services.uploads import ResumableUploadService


router = APIRouter()


def _to_response(session: dict) -> UploadSessionResponse:
    return UploadSessionResponse(
        upload_id=session["upload_id"],
        filename=session["filename"],
        size_bytes=session["size_bytes"],
        chunk_size=session["chunk_size"],
        total_chunks=session["total_chunks"],
        received_chunks=session.get("received_chunks", []),
        received_bytes=session.get("received_bytes", 0),
        status=session["status"],
        stage=session.get("stage"),
        srt_offset_ms=int(session.get("srt_offset_ms") or 0),
        processing_percent=int(session.get("processing_percent") or 0),
        processing_message=session.get("processing_message"),
        processing_attempt=int(session.get("processing_attempt") or 0),
        accepted_segments=int(session.get("accepted_segments") or 0),
        rejected_segments=int(session.get("rejected_segments") or 0),
        current_segment_index=int(session.get("current_segment_index") or 0),
        total_segments=int(session.get("total_segments") or 0),
        created_at=session.get("created_at"),
        upload_completed_at=session.get("upload_completed_at"),
        processing_started_at=session.get("processing_started_at"),
        processing_completed_at=session.get("processing_completed_at"),
        processing_elapsed_seconds=session.get("processing_elapsed_seconds"),
        last_updated_at=session.get("last_updated_at"),
        error=session.get("error"),
        voice_profile_id=session.get("voice_profile_id"),
    )


@router.post("/sessions", response_model=UploadSessionResponse)
def create_upload_session(payload: CreateUploadSessionRequest) -> UploadSessionResponse:
    try:
        session = ResumableUploadService().create_session(
            filename=payload.filename,
            content_type=payload.content_type,
            size_bytes=payload.size_bytes,
            name=payload.name,
            transcript_text=payload.transcript_text,
            srt_offset_ms=payload.srt_offset_ms,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_response(session)


@router.get("/sessions/{upload_id}", response_model=UploadSessionResponse)
def get_upload_session(upload_id: str) -> UploadSessionResponse:
    try:
        session = ResumableUploadService().get_session(upload_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _to_response(session)


@router.put("/sessions/{upload_id}/chunks/{chunk_index}", response_model=UploadSessionResponse)
async def upload_chunk(upload_id: str, chunk_index: int, request: Request) -> UploadSessionResponse:
    try:
        session = await ResumableUploadService().write_chunk(upload_id, chunk_index, request.stream())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_response(session)


@router.put("/sessions/{upload_id}/transcript/{filename}", response_model=UploadSessionResponse)
async def upload_transcript(upload_id: str, filename: str, request: Request) -> UploadSessionResponse:
    try:
        session = await ResumableUploadService().write_transcript(upload_id, filename, request.stream())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_response(session)


@router.post("/sessions/{upload_id}/complete", response_model=CompleteUploadSessionResponse)
def complete_upload_session(upload_id: str, background_tasks: BackgroundTasks) -> CompleteUploadSessionResponse:
    try:
        ResumableUploadService().complete_session(upload_id)
        background_tasks.add_task(ResumableUploadService().process_completed_upload, upload_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CompleteUploadSessionResponse(
        upload_id=upload_id,
        status="processing",
        message="Upload completed and background processing has started.",
    )


@router.post("/sessions/{upload_id}/retry-processing", response_model=CompleteUploadSessionResponse)
def retry_upload_processing(upload_id: str, background_tasks: BackgroundTasks) -> CompleteUploadSessionResponse:
    try:
        ResumableUploadService().prepare_retry_processing(upload_id)
        background_tasks.add_task(ResumableUploadService().process_completed_upload, upload_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CompleteUploadSessionResponse(
        upload_id=upload_id,
        status="processing",
        message="Retry processing started from the original uploaded audio and transcript.",
    )


@router.post("/sessions/{upload_id}/cancel", response_model=CompleteUploadSessionResponse)
def cancel_upload_processing(upload_id: str) -> CompleteUploadSessionResponse:
    try:
        ResumableUploadService().cancel_processing(upload_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CompleteUploadSessionResponse(
        upload_id=upload_id,
        status="cancel_requested",
        message="Cancellation requested. Current processing will stop at the next safe checkpoint.",
    )