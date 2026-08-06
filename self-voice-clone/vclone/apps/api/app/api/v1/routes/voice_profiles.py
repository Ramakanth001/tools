import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db_session
from app.models.voice_profile import VoiceProfile
from app.schemas.voice_profile import (
    AdaptationExportRequest,
    AdaptationExportResponse,
    AdaptationPrepareF5Request,
    AdaptationPrepareF5Response,
    AdaptationStatusResponse,
    AdaptedCheckpointImportRequest,
    AdaptedCheckpointImportResponse,
    CreateVoiceProfileRequest,
    SimpleVoiceProfileResponse,
    VoiceProfileDetail,
    VoiceProfileListResponse,
    VoiceProfileResponse,
)
from app.services.adaptation_dataset import AdaptationDatasetExporter
from app.services.adapted_engines import F5FinetunedEngine, register_adapted_model_in_report
from app.services.voice_profiles import VoiceProfileService


router = APIRouter()


@router.post("", response_model=SimpleVoiceProfileResponse)
async def create_simple_voice_profile(
    name: str = Form("My Voice"),
    transcript_text: str = Form(""),
    audio_file: UploadFile = File(...),
    transcript_file: UploadFile | None = File(default=None),
    db: Session = Depends(get_db_session),
) -> SimpleVoiceProfileResponse:
    service = VoiceProfileService(db)
    service.ensure_schema()
    try:
        profile = service.create_simple_profile(
            name=name,
            transcript_text=transcript_text,
            audio_filename=audio_file.filename or "sample-audio.bin",
            audio_bytes=await audio_file.read(),
            transcript_filename=transcript_file.filename if transcript_file else None,
            transcript_bytes=await transcript_file.read() if transcript_file else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SimpleVoiceProfileResponse(
        voice_profile_id=profile.id,
        status=profile.status,
        name=profile.name,
        readiness_report=json.loads(profile.readiness_report_json or "{}"),
    )


@router.post("/create/from-enrollment/{enrollment_id}", response_model=VoiceProfileResponse)
def create_voice_profile(
    enrollment_id: str, payload: CreateVoiceProfileRequest, db: Session = Depends(get_db_session)
) -> VoiceProfileResponse:
    try:
        profile, job_id = VoiceProfileService(db).create_profile(enrollment_id, **payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return VoiceProfileResponse(voice_profile_id=profile.id, job_id=job_id)


@router.get("", response_model=VoiceProfileListResponse)
def list_voice_profiles(db: Session = Depends(get_db_session)) -> VoiceProfileListResponse:
    service = VoiceProfileService(db)
    service.ensure_schema()
    profiles = service.list_profiles()
    items = [
        VoiceProfileDetail(
            id=profile.id,
            name=profile.name,
            enrollment_id=profile.enrollment_id,
            status=profile.status,
            engine_family=profile.engine_family,
            base_model_version=profile.base_model_version,
            readiness_report=json.loads(profile.readiness_report_json or "{}"),
        )
        for profile in profiles
    ]
    return VoiceProfileListResponse(items=items)


@router.get("/{voice_profile_id}", response_model=VoiceProfileDetail)
def get_voice_profile(voice_profile_id: str, db: Session = Depends(get_db_session)) -> VoiceProfileDetail:
    service = VoiceProfileService(db)
    service.ensure_schema()
    profile = service.get_profile(voice_profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Voice profile not found")

    return VoiceProfileDetail(
        id=profile.id,
        name=profile.name,
        enrollment_id=profile.enrollment_id,
        status=profile.status,
        engine_family=profile.engine_family,
        base_model_version=profile.base_model_version,
        readiness_report=json.loads(profile.readiness_report_json or "{}"),
    )


@router.post("/{voice_profile_id}/deep-quality-check", response_model=VoiceProfileDetail)
def start_deep_quality_check(voice_profile_id: str, db: Session = Depends(get_db_session)) -> VoiceProfileDetail:
    service = VoiceProfileService(db)
    service.ensure_schema()
    try:
        profile = service.start_deep_quality_check(voice_profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return VoiceProfileDetail(
        id=profile.id,
        name=profile.name,
        enrollment_id=profile.enrollment_id,
        status=profile.status,
        engine_family=profile.engine_family,
        base_model_version=profile.base_model_version,
        readiness_report=json.loads(profile.readiness_report_json or "{}"),
    )


@router.post("/{voice_profile_id}/adaptation/export", response_model=AdaptationExportResponse)
def export_adaptation_dataset(
    voice_profile_id: str,
    payload: AdaptationExportRequest | None = None,
    db: Session = Depends(get_db_session),
) -> AdaptationExportResponse:
    payload = payload or AdaptationExportRequest()
    profile = _get_profile_or_404(db, voice_profile_id)
    output_dir = payload.output_dir or str(Path("../../training-runs") / _safe_slug(profile.name, profile.id))
    try:
        manifest = AdaptationDatasetExporter(db).export_profile(
            voice_profile_id=voice_profile_id,
            output_dir=output_dir,
            min_seconds=payload.min_seconds,
            max_seconds=payload.max_seconds,
            speaker_id=payload.speaker_id,
        )
        _write_training_package(manifest)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to export adaptation dataset: {exc}") from exc
    return AdaptationExportResponse(status=str(manifest.get("status") or "unknown"), manifest=manifest)


@router.post("/{voice_profile_id}/adaptation/prepare-f5tts", response_model=AdaptationPrepareF5Response)
def prepare_f5tts_dataset(
    voice_profile_id: str,
    payload: AdaptationPrepareF5Request | None = None,
    db: Session = Depends(get_db_session),
) -> AdaptationPrepareF5Response:
    payload = payload or AdaptationPrepareF5Request()
    profile = _get_profile_or_404(db, voice_profile_id)
    dataset_dir = payload.dataset_dir or str(Path("../../training-runs") / _safe_slug(profile.name, profile.id) / "dataset")
    try:
        result = AdaptationDatasetExporter().prepare_f5tts_layout(dataset_dir=dataset_dir, output_dir=payload.output_dir)
        _write_training_package({"dataset_dir": dataset_dir})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to prepare F5-TTS dataset: {exc}") from exc
    return AdaptationPrepareF5Response(status=str(result.get("status") or "unknown"), result=result)


@router.post("/{voice_profile_id}/adaptation/import-checkpoint", response_model=AdaptedCheckpointImportResponse)
def import_adapted_checkpoint(
    voice_profile_id: str,
    payload: AdaptedCheckpointImportRequest,
    db: Session = Depends(get_db_session),
) -> AdaptedCheckpointImportResponse:
    if payload.engine != "f5_finetuned":
        raise HTTPException(status_code=400, detail="Only f5_finetuned checkpoint registration is currently supported.")
    profile = _get_profile_or_404(db, voice_profile_id)
    model_payload = F5FinetunedEngine.registration_payload(
        checkpoint_path=payload.checkpoint_path,
        config_path=payload.config_path,
        dataset_manifest_path=payload.dataset_manifest_path,
        notes=payload.notes,
    )
    profile.readiness_report_json = register_adapted_model_in_report(
        profile.readiness_report_json,
        engine=payload.engine,
        model_payload=model_payload,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return AdaptedCheckpointImportResponse(
        status="registered",
        voice_profile_id=profile.id,
        model=model_payload,
        readiness_report=json.loads(profile.readiness_report_json or "{}"),
    )


@router.get("/{voice_profile_id}/adaptation/status", response_model=AdaptationStatusResponse)
def get_adaptation_status(voice_profile_id: str, db: Session = Depends(get_db_session)) -> AdaptationStatusResponse:
    profile = _get_profile_or_404(db, voice_profile_id)
    report = json.loads(profile.readiness_report_json or "{}")
    adapted = report.get("adapted_models") or {}
    true_voice = report.get("true_voice_adoption") or {}
    clone_dataset = report.get("clone_dataset") or {}
    recommended = [
        "Export adaptation dataset from the curated profile.",
        "Train F5-TTS on a free GPU environment such as Kaggle/Colab.",
        "Import the trained checkpoint and benchmark it against VoxCPM2.",
    ]
    if (clone_dataset.get("curated_minutes") or 0) < 60:
        recommended.append("For stronger Sanskrit identity, add 20-60+ minutes of Sanskrit-heavy recordings.")
    if adapted:
        recommended.insert(0, "Run benchmark comparison before making the adapted model the default final engine.")
    return AdaptationStatusResponse(
        voice_profile_id=profile.id,
        status="adapted_model_registered" if adapted else "no_adapted_model_registered",
        adapted_models=adapted,
        true_voice_adoption=true_voice,
        recommended_next_steps=recommended,
    )


def _get_profile_or_404(db: Session, voice_profile_id: str) -> VoiceProfile:
    profile = db.get(VoiceProfile, voice_profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Voice profile not found")
    return profile


def _safe_slug(name: str, profile_id: str) -> str:
    slug = "-".join("".join(ch.lower() if ch.isalnum() else " " for ch in (name or "voice")).split())
    return f"{slug or 'voice'}-{profile_id[:8]}"


def _write_training_package(manifest: dict) -> None:
    dataset_dir_value = manifest.get("dataset_dir") or manifest.get("dataset")
    if not dataset_dir_value:
        return
    dataset_dir = Path(str(dataset_dir_value))
    if not dataset_dir.exists():
        return
    package_dir = dataset_dir.parent / "f5tts_training_package"
    package_dir.mkdir(parents=True, exist_ok=True)
    f5_dir = dataset_dir / "f5tts"
    metadata_source = f5_dir / "metadata.csv" if (f5_dir / "metadata.csv").exists() else dataset_dir / "f5tts_metadata.csv"
    if metadata_source.exists():
        (package_dir / "metadata.csv").write_bytes(metadata_source.read_bytes())
    readme = package_dir / "README.md"
    readme.write_text(
        "# Free F5-TTS training package\n\n"
        "Use this package in a free GPU notebook such as Kaggle or Colab. Copy/upload the adjacent dataset `wavs/` "
        "or use the full exported dataset folder. Train F5-TTS externally, download the checkpoint, then import it "
        "back into this app with the adapted checkpoint import endpoint/script.\n\n"
        "Important: for Sanskrit voice adoption, add Sanskrit-heavy clean recordings and re-export before final training.\n",
        encoding="utf-8",
    )
