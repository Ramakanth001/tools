from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Enrollment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "enrollments"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    locale: Mapped[str] = mapped_column(String(20))
    consent_text_version: Mapped[str] = mapped_column(String(50))
    intended_use: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(50), default="created")
    liveness_phrase: Mapped[str] = mapped_column(String(255))


class ConsentArtifact(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "consent_artifacts"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id"), index=True)
    consent_text_version: Mapped[str] = mapped_column(String(50))
    accepted_at: Mapped[str] = mapped_column(String(40))
    ip_hash: Mapped[str] = mapped_column(String(255))
    ua_hash: Mapped[str] = mapped_column(String(255))
    signature_blob_key: Mapped[str] = mapped_column(String(255))


class LivenessCheck(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "liveness_checks"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id"), index=True)
    challenge_phrase: Mapped[str] = mapped_column(String(255))
    recording_asset_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    anti_replay_score: Mapped[int] = mapped_column(Integer, default=0)
    result: Mapped[str] = mapped_column(String(50), default="pending")


class SourceAudioAsset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "source_audio_assets"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id"), index=True)
    object_key: Mapped[str] = mapped_column(String(255), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    ingest_status: Mapped[str] = mapped_column(String(50), default="pending_upload")


class TranscriptAsset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "subtitle_transcript_assets"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id"), index=True)
    object_key: Mapped[str] = mapped_column(String(255), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(20))
    language: Mapped[str | None] = mapped_column(String(20), nullable=True)
    parse_status: Mapped[str] = mapped_column(String(50), default="pending_upload")
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
