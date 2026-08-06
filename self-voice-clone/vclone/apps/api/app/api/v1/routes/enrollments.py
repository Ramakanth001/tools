from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db_session
from app.schemas.enrollment import (
    CreateEnrollmentRequest,
    EnrollmentResponse,
    JobCreatedResponse,
    PresignAudioRequest,
    PresignTranscriptRequest,
    PresignUploadResponse,
    UploadLimits,
    ValidateEnrollmentRequest,
)
from app.services.enrollment import EnrollmentService
from app.services.storage import StorageService


router = APIRouter()


@router.post("", response_model=EnrollmentResponse)
def create_enrollment(payload: CreateEnrollmentRequest, db: Session = Depends(get_db_session)) -> EnrollmentResponse:
    enrollment = EnrollmentService(db).create_enrollment(**payload.model_dump())
    return EnrollmentResponse(
        enrollment_id=enrollment.id,
        liveness_phrase=enrollment.liveness_phrase,
        upload_limits=UploadLimits(max_files=200, max_total_minutes=240),
    )


@router.post("/{enrollment_id}/audio:presign", response_model=PresignUploadResponse)
def presign_audio(enrollment_id: str, payload: PresignAudioRequest, db: Session = Depends(get_db_session)) -> PresignUploadResponse:
    try:
        asset = EnrollmentService(db).create_audio_asset(enrollment_id, payload.filename, payload.content_type, payload.size_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return PresignUploadResponse(
        asset_id=asset.id,
        upload_url=StorageService().build_upload_url(asset.object_key),
        object_key=asset.object_key,
    )


@router.post("/{enrollment_id}/transcripts:presign", response_model=PresignUploadResponse)
def presign_transcript(
    enrollment_id: str, payload: PresignTranscriptRequest, db: Session = Depends(get_db_session)
) -> PresignUploadResponse:
    try:
        asset = EnrollmentService(db).create_transcript_asset(enrollment_id, payload.filename, payload.type, payload.language)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return PresignUploadResponse(
        asset_id=asset.id,
        upload_url=StorageService().build_upload_url(asset.object_key),
        object_key=asset.object_key,
    )


@router.post("/{enrollment_id}/validate", response_model=JobCreatedResponse)
def validate_enrollment(
    enrollment_id: str, payload: ValidateEnrollmentRequest, db: Session = Depends(get_db_session)
) -> JobCreatedResponse:
    try:
        job_id = EnrollmentService(db).validate(enrollment_id, payload.audio_asset_ids, payload.transcript_asset_ids)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JobCreatedResponse(job_id=job_id, status="QUEUED")
