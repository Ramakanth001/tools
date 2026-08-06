from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models import *  # noqa: F401,F403
from app.services.voice_profiles import VoiceProfileService


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        VoiceProfileService(db).ensure_schema()
    finally:
        db.close()
