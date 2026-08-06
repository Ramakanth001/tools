from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class GeneratedAsset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "generated_assets"

    synthesis_job_id: Mapped[str] = mapped_column(ForeignKey("synthesis_jobs.id"), index=True)
    format: Mapped[str] = mapped_column(String(20), default="wav")
    sample_rate: Mapped[int] = mapped_column(Integer, default=24000)
    channels: Mapped[int] = mapped_column(Integer, default=1)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    object_key: Mapped[str] = mapped_column(String(255), unique=True)
    watermark_info_json: Mapped[str] = mapped_column(Text, default="{}")
    checksum_sha256: Mapped[str] = mapped_column(String(128), default="")
