from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session
from app.db.session import SessionLocal
from app.schemas.synthesis import DownloadUrlResponse, SmokeTestJobResponse, SmokeTestRequest, SmokeTestStatusResponse, SynthesisJobResponse, SynthesisPreviewResponse, SynthesisRequest
from app.services.smoke_tests import SmokeTestService
from app.services.synthesis import SynthesisService


router = APIRouter()


def _audio_media_type_for_path(path: str) -> str:
    extension = Path(path).suffix.lower()
    if extension == ".flac":
        return "audio/flac"
    if extension == ".wav":
        return "audio/wav"
    return "application/octet-stream"


def run_synthesis_job_background(job_id: str) -> None:
    db = SessionLocal()
    try:
        SynthesisService(db).run_job(job_id)
    finally:
        db.close()


def run_smoke_test_background(job_id: str) -> None:
    db = SessionLocal()
    try:
        SmokeTestService(db).run_job(job_id)
    finally:
        db.close()


@router.post("", response_model=SynthesisJobResponse)
def submit_synthesis(
    payload: SynthesisRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db_session),
) -> SynthesisJobResponse:
    try:
        job = SynthesisService(db).create_job(**payload.model_dump())
        background_tasks.add_task(run_synthesis_job_background, job.id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - convert unexpected synthesis create failures into JSON 500s for the UI.
        raise HTTPException(status_code=500, detail=f"Failed to create synthesis job: {exc}") from exc
    return SynthesisJobResponse(
        job_id=job.id,
        status=job.status.upper(),
        message="Synthesis job queued. The frontend will poll for progress and download when complete.",
    )


@router.get("/{job_id}/preview", response_model=SynthesisPreviewResponse)
def get_preview(job_id: str, db: Session = Depends(get_db_session)) -> SynthesisPreviewResponse:
    try:
        return SynthesisPreviewResponse(**SynthesisService(db).get_preview(job_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - preview/status should always return a JSON error if something unexpected happens.
        raise HTTPException(status_code=500, detail=f"Failed to read synthesis preview: {exc}") from exc


@router.post("/{job_id}/cancel", response_model=SynthesisJobResponse)
def cancel_synthesis(job_id: str, db: Session = Depends(get_db_session)) -> SynthesisJobResponse:
    try:
        job = SynthesisService(db).cancel_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return SynthesisJobResponse(
        job_id=job.id,
        status=job.status.upper(),
        message="Cancellation requested. The synthesis worker will stop at the next safe checkpoint.",
    )


@router.post("/smoke-test", response_model=SmokeTestJobResponse)
def start_smoke_test(
    payload: SmokeTestRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db_session),
) -> SmokeTestJobResponse:
    try:
        job = SmokeTestService(db).create_job(**payload.model_dump())
        background_tasks.add_task(run_smoke_test_background, job["job_id"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to start smoke/mock test: {exc}") from exc
    return SmokeTestJobResponse(job_id=job["job_id"], status=str(job["status"]).upper(), message="Smoke/mock test queued.")


@router.get("/smoke-test/{job_id}", response_model=SmokeTestStatusResponse)
def get_smoke_test(job_id: str) -> SmokeTestStatusResponse:
    try:
        return SmokeTestStatusResponse(**SmokeTestService().get_status(job_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/smoke-test/{job_id}/cancel", response_model=SmokeTestStatusResponse)
def cancel_smoke_test(job_id: str) -> SmokeTestStatusResponse:
    try:
        return SmokeTestStatusResponse(**SmokeTestService().cancel_job(job_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/smoke-test/{job_id}/file/{filename}")
def download_smoke_test_file(job_id: str, filename: str) -> FileResponse:
    try:
        path = SmokeTestService().get_file_path(job_id, filename)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, media_type=_audio_media_type_for_path(path), filename=Path(path).name)


@router.post("/{job_id}/download-url", response_model=DownloadUrlResponse)
def create_download_url(job_id: str, db: Session = Depends(get_db_session)) -> DownloadUrlResponse:
    try:
        return DownloadUrlResponse(**SynthesisService(db).get_download_url(job_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to create download URL: {exc}") from exc


@router.get("/{job_id}/file")
def download_generated_file(job_id: str, db: Session = Depends(get_db_session)) -> FileResponse:
    try:
        path = SynthesisService(db).get_generated_file_path(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, media_type=_audio_media_type_for_path(path), filename=Path(path).name)
