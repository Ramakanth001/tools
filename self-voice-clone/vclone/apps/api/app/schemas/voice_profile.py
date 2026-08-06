from pydantic import BaseModel


class CreateVoiceProfileRequest(BaseModel):
    mode: str = "mvp_embedding"
    engine_preference: str = "auto"
    allow_adaptation: bool = True


class VoiceProfileResponse(BaseModel):
    voice_profile_id: str
    job_id: str


class SimpleVoiceProfileResponse(BaseModel):
    voice_profile_id: str
    status: str
    name: str
    readiness_report: dict | None = None


class VoiceProfileDetail(BaseModel):
    id: str
    name: str
    enrollment_id: str
    status: str
    engine_family: str
    base_model_version: str
    readiness_report: dict


class VoiceProfileListResponse(BaseModel):
    items: list[VoiceProfileDetail]


class AdaptationExportRequest(BaseModel):
    output_dir: str | None = None
    min_seconds: float = 2.0
    max_seconds: float = 18.0
    speaker_id: str | None = None


class AdaptationExportResponse(BaseModel):
    status: str
    manifest: dict


class AdaptationPrepareF5Request(BaseModel):
    dataset_dir: str | None = None
    output_dir: str | None = None


class AdaptationPrepareF5Response(BaseModel):
    status: str
    result: dict


class AdaptedCheckpointImportRequest(BaseModel):
    engine: str = "f5_finetuned"
    checkpoint_path: str
    config_path: str | None = None
    dataset_manifest_path: str | None = None
    notes: str = ""


class AdaptedCheckpointImportResponse(BaseModel):
    status: str
    voice_profile_id: str
    model: dict
    readiness_report: dict


class AdaptationStatusResponse(BaseModel):
    voice_profile_id: str
    status: str
    adapted_models: dict
    true_voice_adoption: dict
    recommended_next_steps: list[str]
