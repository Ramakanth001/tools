from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class SynthesisJob(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "synthesis_jobs"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    voice_profile_id: Mapped[str] = mapped_column(ForeignKey("voice_profiles.id"), index=True)
    mode: Mapped[str] = mapped_column(String(20), default="preview")
    status: Mapped[str] = mapped_column(String(20), default="queued")
    request_json: Mapped[str] = mapped_column(Text)
    normalized_text: Mapped[str] = mapped_column(Text)
    output_text_chunks: Mapped[str] = mapped_column(Text, default="[]")
