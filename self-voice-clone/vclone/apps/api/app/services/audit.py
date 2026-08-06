import json

from sqlalchemy.orm import Session

from app.models.audit_event import AuditEvent


class AuditService:
    def __init__(self, db: Session):
        self.db = db

    def log(self, *, actor_user_id: str, action: str, target_type: str, target_id: str, payload: dict | None = None) -> AuditEvent:
        event = AuditEvent(
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            payload_json=json.dumps(payload or {}),
        )
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event
