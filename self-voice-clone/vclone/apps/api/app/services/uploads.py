from __future__ import annotations

import json
import math
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.voice_profiles import VoiceProfileService


class ResumableUploadService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.root_dir = Path("uploads") / "resumable"
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def create_session(self, filename: str, content_type: str, size_bytes: int, name: str, transcript_text: str, srt_offset_ms: int = 0) -> dict:
        if size_bytes <= 0:
            raise ValueError("Upload size must be greater than zero")
        if size_bytes > self.settings.upload_max_size_bytes:
            raise ValueError(f"Upload is too large. Maximum allowed size is {self.settings.upload_max_size_bytes} bytes")
        self._ensure_disk_space(size_bytes)

        upload_id = str(uuid4())
        chunk_size = self.settings.upload_chunk_size_bytes
        total_chunks = math.ceil(size_bytes / chunk_size)
        session_dir = self._session_dir(upload_id)
        self._chunks_dir(upload_id).mkdir(parents=True, exist_ok=True)

        metadata = {
            "upload_id": upload_id,
            "filename": Path(filename).name or "audio.bin",
            "content_type": content_type or "application/octet-stream",
            "size_bytes": size_bytes,
            "chunk_size": chunk_size,
            "total_chunks": total_chunks,
            "name": name or "My Voice",
            "transcript_text": transcript_text or "",
            "transcript_path": None,
            "transcript_filename": None,
            "srt_offset_ms": int(srt_offset_ms or 0),
            "status": "uploading",
            "stage": "uploading",
            "error": None,
            "voice_profile_id": None,
            "final_path": None,
            "processing_percent": 0,
            "processing_message": "Waiting for upload chunks.",
            "processing_attempt": 0,
            "accepted_segments": 0,
            "rejected_segments": 0,
            "current_segment_index": 0,
            "total_segments": 0,
            "created_at": self._now(),
            "upload_completed_at": None,
            "processing_started_at": None,
            "processing_completed_at": None,
            "processing_elapsed_seconds": None,
            "last_updated_at": self._now(),
        }
        self._write_metadata(upload_id, metadata)
        return self.get_session(upload_id)

    async def write_transcript(self, upload_id: str, filename: str, stream) -> dict:
        metadata = self._read_metadata(upload_id)
        if metadata["status"] not in {"uploading", "failed"}:
            raise ValueError(f"Cannot upload transcript while session status is {metadata['status']}")

        safe_name = Path(filename).name or "transcript.srt"
        if not safe_name.lower().endswith((".srt", ".txt")):
            raise ValueError("Transcript must be an .srt or .txt file")

        transcript_path = self._session_dir(upload_id) / safe_name
        tmp_path = transcript_path.with_suffix(transcript_path.suffix + ".part")
        bytes_written = 0
        with tmp_path.open("wb") as file_handle:
            async for data in stream:
                bytes_written += len(data)
                if bytes_written > 25 * 1024 * 1024:
                    tmp_path.unlink(missing_ok=True)
                    raise ValueError("Transcript file is too large")
                file_handle.write(data)
        tmp_path.replace(transcript_path)

        metadata["transcript_path"] = str(transcript_path)
        metadata["transcript_filename"] = safe_name
        metadata["stage"] = "transcript_uploaded"
        metadata["error"] = None
        self._write_metadata(upload_id, metadata)
        return self.get_session(upload_id)

    def get_session(self, upload_id: str) -> dict:
        metadata = self._read_metadata(upload_id)
        received_chunks = self._received_chunks(upload_id)
        chunk_size = int(metadata["chunk_size"])
        size_bytes = int(metadata["size_bytes"])
        received_bytes = 0
        for chunk_index in received_chunks:
            if chunk_index == int(metadata["total_chunks"]) - 1:
                received_bytes += size_bytes - (chunk_index * chunk_size)
            else:
                received_bytes += chunk_size

        metadata["received_chunks"] = received_chunks
        metadata["received_bytes"] = min(received_bytes, size_bytes)
        return metadata

    async def write_chunk(self, upload_id: str, chunk_index: int, stream) -> dict:
        metadata = self._read_metadata(upload_id)
        total_chunks = int(metadata["total_chunks"])
        if chunk_index < 0 or chunk_index >= total_chunks:
            raise ValueError("Chunk index is out of range")
        if metadata["status"] not in {"uploading", "failed"}:
            raise ValueError(f"Cannot upload chunks while session status is {metadata['status']}")

        metadata["status"] = "uploading"
        metadata["stage"] = "uploading"
        metadata["error"] = None
        self._write_metadata(upload_id, metadata)

        chunk_path = self._chunk_path(upload_id, chunk_index)
        tmp_path = chunk_path.with_suffix(".part")
        bytes_written = 0
        with tmp_path.open("wb") as file_handle:
            async for data in stream:
                bytes_written += len(data)
                file_handle.write(data)
        tmp_path.replace(chunk_path)

        expected_size = self._expected_chunk_size(metadata, chunk_index)
        if bytes_written != expected_size:
            chunk_path.unlink(missing_ok=True)
            raise ValueError(f"Chunk {chunk_index} size mismatch: expected {expected_size}, received {bytes_written}")

        return self.get_session(upload_id)

    def complete_session(self, upload_id: str) -> dict:
        metadata = self._read_metadata(upload_id)
        received_chunks = set(self._received_chunks(upload_id))
        expected_chunks = set(range(int(metadata["total_chunks"])))
        missing_chunks = sorted(expected_chunks - received_chunks)
        if missing_chunks:
            raise ValueError(f"Upload is incomplete. Missing chunks: {missing_chunks[:10]}")

        metadata["status"] = "processing"
        metadata["stage"] = "assembling"
        metadata["error"] = None
        self._write_metadata(upload_id, metadata)

        final_path = self._session_dir(upload_id) / metadata["filename"]
        tmp_final_path = final_path.with_suffix(final_path.suffix + ".part")
        with tmp_final_path.open("wb") as output:
            for chunk_index in range(int(metadata["total_chunks"])):
                with self._chunk_path(upload_id, chunk_index).open("rb") as input_chunk:
                    shutil.copyfileobj(input_chunk, output, length=1024 * 1024)
        tmp_final_path.replace(final_path)

        actual_size = final_path.stat().st_size
        if actual_size != int(metadata["size_bytes"]):
            metadata["status"] = "failed"
            metadata["stage"] = "failed"
            metadata["error"] = f"Assembled file size mismatch: expected {metadata['size_bytes']}, got {actual_size}"
            self._write_metadata(upload_id, metadata)
            raise ValueError(metadata["error"])

        metadata["final_path"] = str(final_path)
        metadata["stage"] = "queued_processing"
        metadata["processing_percent"] = 5
        metadata["processing_message"] = "Upload assembled. Waiting for background processing."
        metadata["upload_completed_at"] = self._now()
        metadata["last_updated_at"] = self._now()
        self._write_metadata(upload_id, metadata)
        return self.get_session(upload_id)

    def prepare_retry_processing(self, upload_id: str) -> dict:
        metadata = self._read_metadata(upload_id)
        final_path = metadata.get("final_path")
        if not final_path or not Path(final_path).exists():
            raise ValueError("Cannot retry: original assembled upload file is missing")
        if Path(final_path).stat().st_size != int(metadata["size_bytes"]):
            raise ValueError("Cannot retry: original assembled upload size does not match session metadata")
        transcript_path = metadata.get("transcript_path")
        if transcript_path and not Path(transcript_path).exists():
            raise ValueError("Cannot retry: transcript file is missing")
        lock_status = self._processing_lock_status(upload_id)
        if lock_status["exists"] and lock_status["stale"]:
            self._lock_path(upload_id).unlink(missing_ok=True)
        elif lock_status["exists"]:
            raise ValueError(
                f"Cannot retry: processing is already running for this upload under PID {lock_status.get('pid')}. "
                "Cancel it or wait for it to finish."
            )
        metadata["status"] = "processing"
        metadata["stage"] = "retry_queued"
        metadata["error"] = None
        metadata["voice_profile_id"] = None
        metadata["processing_attempt"] = int(metadata.get("processing_attempt") or 0) + 1
        metadata["processing_percent"] = 1
        metadata["processing_message"] = "Retrying processing from original uploaded audio and transcript."
        metadata["accepted_segments"] = 0
        metadata["rejected_segments"] = 0
        metadata["current_segment_index"] = 0
        metadata["total_segments"] = 0
        metadata["processing_started_at"] = None
        metadata["processing_completed_at"] = None
        metadata["processing_elapsed_seconds"] = None
        metadata["last_updated_at"] = self._now()
        self._write_metadata(upload_id, metadata)
        return self.get_session(upload_id)

    def cancel_processing(self, upload_id: str) -> dict:
        metadata = self._read_metadata(upload_id)
        if metadata.get("status") not in {"processing", "failed", "completed", "cancel_requested"}:
            raise ValueError(f"Cannot cancel session while status is {metadata.get('status')}")
        self._cancel_path(upload_id).write_text(self._now())
        lock_status = self._processing_lock_status(upload_id)
        if lock_status["exists"] and lock_status["stale"]:
            self._lock_path(upload_id).unlink(missing_ok=True)
            metadata["status"] = "cancelled"
            metadata["stage"] = "cancelled"
            metadata["processing_message"] = "Stale processing lock was cleared. Processing is cancelled and safe to retry."
        else:
            metadata["status"] = "cancel_requested"
            metadata["stage"] = "cancel_requested"
            metadata["processing_message"] = "Cancellation requested. Processing will stop at the next safe checkpoint."
        metadata["last_updated_at"] = self._now()
        self._write_metadata(upload_id, metadata)
        return self.get_session(upload_id)

    def process_completed_upload(self, upload_id: str) -> None:
        metadata = self._read_metadata(upload_id)
        db = SessionLocal()
        lock_acquired = False
        try:
            self._acquire_processing_lock(upload_id)
            lock_acquired = True
            self._cancel_path(upload_id).unlink(missing_ok=True)
            if not metadata.get("processing_attempt"):
                metadata["processing_attempt"] = 1
            metadata["processing_started_at"] = self._now()
            metadata["processing_completed_at"] = None
            metadata["processing_elapsed_seconds"] = None
            self._write_metadata(upload_id, metadata)
            self._update_processing(upload_id, stage="creating_voice_profile", percent=10, message="Starting voice profile creation from original upload.")

            def progress(update: dict) -> None:
                self._raise_if_cancelled(upload_id)
                self._update_processing(upload_id, **update)

            progress({"stage": "processing_attempt", "percent": 8, "message": f"Processing attempt {metadata.get('processing_attempt') or 1} started."})

            voice_profile_service = VoiceProfileService(db)
            voice_profile_service.ensure_schema()
            profile = voice_profile_service.create_profile_from_uploaded_file(
                name=metadata["name"],
                audio_path=metadata["final_path"],
                transcript_text=metadata.get("transcript_text") or "",
                transcript_path=metadata.get("transcript_path"),
                srt_offset_ms=int(metadata.get("srt_offset_ms") or 0),
                progress_callback=progress,
            )
            metadata = self._read_metadata(upload_id)
            metadata["status"] = "completed"
            metadata["stage"] = "completed"
            metadata["processing_percent"] = 100
            metadata["processing_message"] = "Voice profile created successfully."
            metadata["voice_profile_id"] = profile.id
            metadata["error"] = None
            metadata["processing_completed_at"] = self._now()
            metadata["processing_elapsed_seconds"] = self._elapsed_seconds(metadata.get("processing_started_at"), metadata.get("processing_completed_at"))
            metadata["last_updated_at"] = self._now()
            self._write_metadata(upload_id, metadata)
        except Exception as exc:  # noqa: BLE001 - preserve actual processing failure for UI diagnostics.
            metadata = self._read_metadata(upload_id)
            cancelled = self._cancel_path(upload_id).exists() or "cancelled" in str(exc).lower()
            metadata["status"] = "cancelled" if cancelled else "failed"
            metadata["stage"] = "cancelled" if cancelled else "failed"
            metadata["processing_percent"] = metadata.get("processing_percent", 0) if cancelled else 100
            metadata["processing_message"] = "Processing cancelled by user." if cancelled else "Processing failed."
            metadata["error"] = str(exc)
            metadata["processing_completed_at"] = self._now()
            metadata["processing_elapsed_seconds"] = self._elapsed_seconds(metadata.get("processing_started_at"), metadata.get("processing_completed_at"))
            metadata["last_updated_at"] = self._now()
            self._write_metadata(upload_id, metadata)
        finally:
            if lock_acquired:
                self._release_processing_lock(upload_id)
            db.close()

    def _update_processing(
        self,
        upload_id: str,
        *,
        stage: str | None = None,
        percent: int | None = None,
        message: str | None = None,
        accepted_segments: int | None = None,
        rejected_segments: int | None = None,
        current_segment_index: int | None = None,
        total_segments: int | None = None,
    ) -> None:
        metadata = self._read_metadata(upload_id)
        metadata["status"] = "processing"
        if stage is not None:
            metadata["stage"] = stage
        if percent is not None:
            metadata["processing_percent"] = max(0, min(100, int(percent)))
        if message is not None:
            metadata["processing_message"] = message
        if accepted_segments is not None:
            metadata["accepted_segments"] = accepted_segments
        if rejected_segments is not None:
            metadata["rejected_segments"] = rejected_segments
        if current_segment_index is not None:
            metadata["current_segment_index"] = current_segment_index
        if total_segments is not None:
            metadata["total_segments"] = total_segments
        metadata["last_updated_at"] = self._now()
        self._write_metadata(upload_id, metadata)

    def _expected_chunk_size(self, metadata: dict, chunk_index: int) -> int:
        chunk_size = int(metadata["chunk_size"])
        size_bytes = int(metadata["size_bytes"])
        if chunk_index == int(metadata["total_chunks"]) - 1:
            return size_bytes - (chunk_index * chunk_size)
        return chunk_size

    def _received_chunks(self, upload_id: str) -> list[int]:
        chunks_dir = self._chunks_dir(upload_id)
        if not chunks_dir.exists():
            return []
        chunks = []
        for path in chunks_dir.glob("*.chunk"):
            try:
                chunks.append(int(path.stem))
            except ValueError:
                continue
        return sorted(chunks)

    def _session_dir(self, upload_id: str) -> Path:
        return self.root_dir / upload_id

    def _chunks_dir(self, upload_id: str) -> Path:
        return self._session_dir(upload_id) / "chunks"

    def _metadata_path(self, upload_id: str) -> Path:
        return self._session_dir(upload_id) / "session.json"

    def _chunk_path(self, upload_id: str, chunk_index: int) -> Path:
        return self._chunks_dir(upload_id) / f"{chunk_index}.chunk"

    def _read_metadata(self, upload_id: str) -> dict:
        metadata_path = self._metadata_path(upload_id)
        if not metadata_path.exists():
            raise ValueError("Upload session not found")
        return json.loads(metadata_path.read_text())

    def _write_metadata(self, upload_id: str, metadata: dict) -> None:
        session_dir = self._session_dir(upload_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = self._metadata_path(upload_id)
        tmp_path = metadata_path.with_suffix(".json.part")
        tmp_path.write_text(json.dumps(metadata, indent=2))
        tmp_path.replace(metadata_path)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _elapsed_seconds(self, start: str | None, end: str | None = None) -> float | None:
        if not start:
            return None
        try:
            start_dt = datetime.fromisoformat(str(start))
            end_dt = datetime.fromisoformat(str(end)) if end else datetime.now(timezone.utc)
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
            if end_dt.tzinfo is None:
                end_dt = end_dt.replace(tzinfo=timezone.utc)
            return round(max(0.0, (end_dt - start_dt).total_seconds()), 3)
        except Exception:
            return None

    def _ensure_disk_space(self, size_bytes: int) -> None:
        usage = shutil.disk_usage(self.root_dir)
        required = int(size_bytes * 2.5) + (2 * 1024 * 1024 * 1024)
        if usage.free < required:
            raise ValueError(
                f"Not enough free disk space for this upload. Required approximately {required} bytes, available {usage.free} bytes."
            )

    def _lock_path(self, upload_id: str) -> Path:
        return self._session_dir(upload_id) / "processing.lock"

    def _cancel_path(self, upload_id: str) -> Path:
        return self._session_dir(upload_id) / "cancel.requested"

    def _acquire_processing_lock(self, upload_id: str) -> None:
        lock_path = self._lock_path(upload_id)
        if lock_path.exists() and self._is_stale_lock(lock_path):
            lock_path.unlink(missing_ok=True)
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as exc:
            raise ValueError("Processing is already running for this upload. Cancel it or wait for it to finish before retrying.") from exc
        with os.fdopen(fd, "w") as handle:
            handle.write(json.dumps({"pid": os.getpid(), "started_at": self._now()}))

    def _release_processing_lock(self, upload_id: str) -> None:
        self._lock_path(upload_id).unlink(missing_ok=True)

    def _raise_if_cancelled(self, upload_id: str) -> None:
        if self._cancel_path(upload_id).exists():
            raise RuntimeError("Processing cancelled by user")

    def _is_stale_lock(self, lock_path: Path) -> bool:
        return self._lock_status(lock_path)["stale"]

    def _processing_lock_status(self, upload_id: str) -> dict:
        return self._lock_status(self._lock_path(upload_id))

    def _lock_status(self, lock_path: Path) -> dict:
        if not lock_path.exists():
            return {"exists": False, "stale": False, "pid": None}
        try:
            payload = json.loads(lock_path.read_text() or "{}")
            pid = int(payload.get("pid") or 0)
            if pid <= 0:
                return {"exists": True, "stale": True, "pid": pid}
            os.kill(pid, 0)
            return {"exists": True, "stale": False, "pid": pid}
        except ProcessLookupError:
            return {"exists": True, "stale": True, "pid": None}
        except Exception:
            return {"exists": True, "stale": True, "pid": None}