from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class VoiceProfile(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "voice_profiles"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="My Voice")
    transcript_text: Mapped[str] = mapped_column(Text, default="")
    source_audio_path: Mapped[str] = mapped_column(String(500), default="")
    sample_audio_path: Mapped[str] = mapped_column(String(500), default="")
    transcript_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    profile_version: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(50), default="ready")
    engine_family: Mapped[str] = mapped_column(String(50), default="mock")
    base_model_version: Mapped[str] = mapped_column(String(50), default="mvp-v1")
    readiness_report_json: Mapped[str] = mapped_column(Text, default="{}")
