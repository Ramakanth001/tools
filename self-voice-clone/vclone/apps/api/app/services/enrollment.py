from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.enrollment import ConsentArtifact, Enrollment, SourceAudioAsset, TranscriptAsset
from app.models.user import User
from app.services.audit import AuditService

LIVENESS_PHRASES = [
    "sunrise delta seven blue",
    "amber ocean nine pine",
    "violet comet three river",
]


class EnrollmentService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = AuditService(db)

    def _ensure_default_user(self) -> User:
        user = self.db.query(User).filter(User.auth_subject == "demo-user").one_or_none()
        if user:
            return user

        user = User(email="demo@vclone.local", auth_subject="demo-user", status="active")
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def create_enrollment(self, locale: str, consent_text_version: str, intended_use: str) -> Enrollment:
        user = self._ensure_default_user()
        phrase = LIVENESS_PHRASES[(datetime.now().second) % len(LIVENESS_PHRASES)]
        enrollment = Enrollment(
            user_id=user.id,
            locale=locale,
            consent_text_version=consent_text_version,
            intended_use=intended_use,
            liveness_phrase=phrase,
            status="created",
        )
        self.db.add(enrollment)
        self.db.commit()
        self.db.refresh(enrollment)

        consent = ConsentArtifact(
            user_id=user.id,
            enrollment_id=enrollment.id,
            consent_text_version=consent_text_version,
            accepted_at=datetime.now(timezone.utc).isoformat(),
            ip_hash="local-dev",
            ua_hash="local-dev",
            signature_blob_key=f"consent/{enrollment.id}.json",
        )
        self.db.add(consent)
        self.db.commit()
        self.audit.log(actor_user_id=user.id, action="enrollment.created", target_type="enrollment", target_id=enrollment.id)
        return enrollment

    def create_audio_asset(self, enrollment_id: str, filename: str, content_type: str, size_bytes: int) -> SourceAudioAsset:
        enrollment = self.db.get(Enrollment, enrollment_id)
        if enrollment is None:
            raise ValueError("Enrollment not found")
        asset = SourceAudioAsset(
            user_id=enrollment.user_id,
            enrollment_id=enrollment_id,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            object_key=f"raw/{enrollment.user_id}/{enrollment_id}/audio/{uuid4()}-{filename}",
        )
        self.db.add(asset)
        self.db.commit()
        self.db.refresh(asset)
        return asset

    def create_transcript_asset(self, enrollment_id: str, filename: str, kind: str, language: str | None) -> TranscriptAsset:
        enrollment = self.db.get(Enrollment, enrollment_id)
        if enrollment is None:
            raise ValueError("Enrollment not found")
        asset = TranscriptAsset(
            user_id=enrollment.user_id,
            enrollment_id=enrollment_id,
            filename=filename,
            kind=kind,
            language=language,
            object_key=f"raw/{enrollment.user_id}/{enrollment_id}/transcripts/{uuid4()}-{filename}",
        )
        self.db.add(asset)
        self.db.commit()
        self.db.refresh(asset)
        return asset

    def validate(self, enrollment_id: str, audio_asset_ids: list[str], transcript_asset_ids: list[str]) -> str:
        enrollment = self.db.get(Enrollment, enrollment_id)
        if enrollment is None:
            raise ValueError("Enrollment not found")
        enrollment.status = "validated"
        self.db.add(enrollment)
        self.db.commit()
        self.audit.log(
            actor_user_id=enrollment.user_id,
            action="enrollment.validated",
            target_type="enrollment",
            target_id=enrollment_id,
            payload={"audio_asset_ids": audio_asset_ids, "transcript_asset_ids": transcript_asset_ids},
        )
        return f"job_val_{enrollment_id[:8]}"
