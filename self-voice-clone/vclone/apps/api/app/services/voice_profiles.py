import json
from pathlib import Path
import shutil
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.enrollment import Enrollment
from app.models.user import User
from app.models.voice_profile import VoiceProfile
from app.services.alignment import AlignmentService
from app.services.audio_processing import AudioProcessingService
from app.services.audio_segmenter import AudioSegmenterService
from app.services.audit import AuditService
from app.services.quality_scoring import QualityScoringService
from app.services.pronunciation import PronunciationService
from app.services.srt_parser import SRTParserService
from app.services.transcription import AutoTranscriptionService
from app.services.voice_dataset import VoiceDatasetBuilder


class VoiceProfileService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = AuditService(db)
        self.transcriber = AutoTranscriptionService()
        self.audio_processor = AudioProcessingService()
        self.audio_segmenter = AudioSegmenterService()
        self.alignment = AlignmentService()
        self.quality_scoring = QualityScoringService()
        self.pronunciation = PronunciationService()
        self.srt_parser = SRTParserService()
        self.voice_dataset_builder = VoiceDatasetBuilder()

    def _create_profile_from_audio_path(
        self,
        name: str,
        audio_path: Path,
        transcript_text: str = "",
        transcript_path: Path | None = None,
        srt_offset_ms: int = 0,
        progress_callback=None,
    ) -> VoiceProfile:
        progress_callback = progress_callback or (lambda _update: None)
        progress_callback({"stage": "preparing_files", "percent": 12, "message": "Preparing original audio and transcript files."})
        user = self._ensure_default_user()

        enrollment = Enrollment(
            user_id=user.id,
            locale="en-IN",
            consent_text_version="simple-local",
            intended_use="personal_tts",
            liveness_phrase="not-required",
            status="validated",
        )
        self.db.add(enrollment)
        self.db.commit()
        self.db.refresh(enrollment)

        base_dir = Path("uploads") / user.id / enrollment.id
        audio_dir = base_dir / "audio"
        transcript_dir = base_dir / "transcript"
        audio_dir.mkdir(parents=True, exist_ok=True)
        transcript_dir.mkdir(parents=True, exist_ok=True)

        if "resumable" in audio_path.parts:
            # Large upload sessions already preserve the original assembled audio. Do not duplicate multi-GB files.
            working_audio_path = audio_path
        else:
            safe_audio_name = f"{uuid4()}-{audio_path.name or 'sample-audio.bin'}"
            working_audio_path = audio_dir / safe_audio_name
            if audio_path.resolve() != working_audio_path.resolve():
                shutil.copy2(audio_path, working_audio_path)

        transcript_path_str = None
        if transcript_path:
            safe_transcript_name = f"{uuid4()}-{transcript_path.name}"
            working_transcript_path = transcript_dir / safe_transcript_name
            if transcript_path.resolve() != working_transcript_path.resolve():
                shutil.copy2(transcript_path, working_transcript_path)
            transcript_path_str = str(working_transcript_path)

        resolved_transcript_text = transcript_text.strip()
        srt_report = None
        curation_report = None
        processing_audio_path = working_audio_path
        srt_curation_used = False
        fast_enrollment_mode = bool(transcript_path and transcript_path.suffix.lower() == ".srt")

        if transcript_path_str and Path(transcript_path_str).suffix.lower() == ".srt":
            progress_callback({"stage": "parsing_srt", "percent": 14, "message": "Parsing SRT transcript."})
            srt_content = Path(transcript_path_str).read_text(encoding="utf-8", errors="ignore")
            srt_result = self.srt_parser.parse_text(srt_content)
            srt_segments = self.srt_parser.apply_offset(srt_result.segments, srt_offset_ms)
            if srt_result.segments:
                if not resolved_transcript_text:
                    resolved_transcript_text = srt_result.full_text
                curation = self.audio_segmenter.curate_from_srt(
                    audio_path=str(working_audio_path),
                    segments=srt_segments,
                    output_dir=str(audio_dir),
                    progress_callback=progress_callback,
                )
                processing_audio_path = Path(curation.curated_audio_path)
                srt_curation_used = curation.curated_audio_path != str(working_audio_path)
                srt_report = {
                    "provided": True,
                    "segment_count": len(srt_result.segments),
                    "srt_offset_ms": srt_offset_ms,
                    "warnings": srt_result.warnings,
                    "preview_segments": [segment.to_dict() for segment in srt_segments[:10]],
                }
                curation_report = curation.to_dict()
            else:
                srt_report = {"provided": True, "segment_count": 0, "warnings": srt_result.warnings + ["No usable SRT entries found."]}

        progress_callback({"stage": "normalizing_conditioning_audio", "percent": 82, "message": "Normalizing conditioning audio."})
        processing_source_duration = self.audio_processor._duration_seconds(processing_audio_path)
        processed_audio = self.audio_processor.process_for_conditioning(
            str(processing_audio_path),
            str(audio_dir),
            preserve_internal_silence=fast_enrollment_mode,
        )
        if fast_enrollment_mode and processing_source_duration >= 120 and processed_audio.duration_seconds < 0.5 * processing_source_duration:
            raise ValueError(
                "Conditioning audio was unexpectedly shortened during processing. Refusing to save a low-quality voice profile."
            )
        selected_duration_seconds = float((curation_report or {}).get("selected_duration_seconds", 0.0) or 0.0)
        if fast_enrollment_mode and selected_duration_seconds >= 300 and processed_audio.duration_seconds < 300:
            raise ValueError(
                "SRT curation selected substantial speech, but the final conditioning audio is too short. Refusing to save a low-quality voice profile."
            )

        transcription = None
        auto_transcribed = False
        if not resolved_transcript_text:
            progress_callback({"stage": "auto_transcribing", "percent": 86, "message": "Auto-transcribing because no transcript/SRT text was available."})
            transcription = self.transcriber.transcribe(str(processing_audio_path))
            if not transcript_path_str:
                resolved_transcript_text = transcription["text"]
                auto_transcribed = True

        progress_callback({"stage": "alignment_scoring", "percent": 90, "message": "Scoring transcript/audio alignment."})
        alignment = self.alignment.align(
            transcript_text=resolved_transcript_text,
            transcript_path=transcript_path_str,
            duration_seconds=processed_audio.duration_seconds,
        )
        if fast_enrollment_mode:
            measured_alignment = {
                "provider": "deferred",
                "confidence": alignment.confidence,
                "observed_text": "",
                "segment_count": curation_report.get("accepted_segment_count", alignment.segment_count) if curation_report else alignment.segment_count,
                "segments": [],
                "notes": ["Heavy ASR backcheck deferred because SRT was supplied; run deep quality analysis separately."],
            }
        else:
            measured_alignment = self.alignment.analyze_audio_alignment(
                audio_path=processed_audio.processed_path,
                transcript_text=resolved_transcript_text,
            )
        transcript_confidence = transcription["confidence"] if transcription else (0.88 if resolved_transcript_text else 0.25)
        progress_callback(
            {
                "stage": "quality_scoring",
                "percent": 94,
                "message": "Computing bounded enrollment quality score. Deep quality checks can run after profile creation.",
            }
        )
        quality = self.quality_scoring.score(
            audio_path=processed_audio.processed_path,
            duration_seconds=processed_audio.duration_seconds,
            alignment_confidence=max(alignment.confidence, float(measured_alignment.get("confidence", 0.0) or 0.0)),
            transcript_confidence=transcript_confidence,
            segment_count=max(alignment.segment_count, int(measured_alignment.get("segment_count", 0) or 0)),
            source_audio_path=str(working_audio_path),
            defer_speaker_verification=fast_enrollment_mode,
            fast_mode=fast_enrollment_mode,
        )

        progress_callback(
            {
                "stage": "building_clone_dataset",
                "percent": 96,
                "message": "Building curated clone dataset and exact prompt bundle for VoxCPM2/Chatterbox.",
            }
        )
        clone_dataset = self.voice_dataset_builder.build(
            source_audio_path=str(working_audio_path),
            processed_audio_path=processed_audio.processed_path,
            transcript_text=resolved_transcript_text,
            output_dir=str(audio_dir),
            curation_report=curation_report,
            progress_callback=progress_callback,
        )
        pronunciation_profile = self.pronunciation.build_profile_from_transcript(resolved_transcript_text)
        prompt_seconds = float((clone_dataset.get("prompt") or {}).get("prompt_seconds") or 0.0)
        engine_prompt_ready = prompt_seconds >= float(self.voice_dataset_builder.settings.voice_prompt_min_seconds)
        if clone_dataset.get("status") in {"adaptation_ready", "zero_shot_ready", "limited_prompt_ready"} and engine_prompt_ready:
            readiness_status = "ready"
        else:
            readiness_status = "ready_with_warning" if clone_dataset.get("status") in {"adaptation_ready", "zero_shot_ready", "limited_prompt_ready"} else processed_audio.readiness_status
        stored_curation_report = self._compact_curation_report(curation_report)

        progress_callback({"stage": "saving_voice_profile", "percent": 98, "message": "Saving voice profile."})
        profile = VoiceProfile(
            user_id=user.id,
            enrollment_id=enrollment.id,
            name=name or "My Voice",
            transcript_text=resolved_transcript_text,
            source_audio_path=str(working_audio_path),
            sample_audio_path=processed_audio.processed_path,
            transcript_path=transcript_path_str,
            status=readiness_status,
            engine_family="voxcpm2_primary_clone",
            base_model_version="curated-clone-profile-v1",
            readiness_report_json=json.dumps(
                {
                    "audio_uploaded": True,
                    "transcript_provided": bool(resolved_transcript_text or transcript_path_str),
                    "transcript_source": "auto" if auto_transcribed else "provided",
                    "reference_audio_seconds": processed_audio.duration_seconds,
                    "accepted_speech_seconds": selected_duration_seconds,
                    "warning_level": processed_audio.warning_level,
                    "guidance": processed_audio.guidance,
                    "alignment": alignment.to_dict(),
                    "srt": srt_report or {"provided": False},
                    "curation": stored_curation_report
                    or {
                        "used": False,
                        "reason": "No usable SRT file was supplied; conditioning audio was created from the uploaded audio directly.",
                    },
                    "measured_alignment": measured_alignment,
                    "quality": quality.to_dict(),
                    "clone_dataset": clone_dataset,
                    "pronunciation_profile": pronunciation_profile,
                    "deep_quality": {
                        "status": "pending",
                        "reason": "Enrollment completed with curation-first clone artifacts. Run deep ASR/speaker checks before final publishing.",
                    },
                    "transcription": transcription or {
                        "provider": "provided",
                        "confidence": transcript_confidence,
                        "segments": [],
                        "notes": [],
                    },
                    "audio_processing": {
                        "source_audio_path": str(working_audio_path),
                        "processing_audio_path": str(processing_audio_path),
                        "processing_source_seconds": processing_source_duration,
                        "conditioning_audio_path": processed_audio.processed_path,
                        "ffmpeg_used": processed_audio.ffmpeg_used,
                        "silence_trimmed": processed_audio.silence_trimmed,
                        "loudness_normalized": processed_audio.loudness_normalized,
                        "archival_source_preserved": True,
                        "conditioning_derivative_created": processed_audio.processed_path != str(working_audio_path),
                    },
                    "storage": "local",
                    "dataset": {
                        "multi_file_support": False,
                        "curated_segment_count": clone_dataset.get("accepted_segment_count", alignment.segment_count),
                        "curated_minutes": clone_dataset.get("curated_minutes", 0.0),
                        "manifest_path": clone_dataset.get("manifest_path"),
                        "adaptation_candidate": bool(clone_dataset.get("engine_readiness", {}).get("voxcpm2_lora_candidate")),
                        "zero_shot_candidate": clone_dataset.get("engine_readiness", {}).get("voxcpm2_ultimate_clone") == "ready",
                        "engine_prompt_ready": engine_prompt_ready,
                        "prompt_seconds": prompt_seconds,
                    },
                    "note": "Enrollment now builds a curated clone dataset and exact prompt bundle. VoxCPM2 is primary, Chatterbox is fallback, XTTS is legacy only.",
                }
            ),
        )
        self.db.add(profile)
        self.db.commit()
        self.db.refresh(profile)
        return profile

    def start_deep_quality_check(self, voice_profile_id: str) -> VoiceProfile:
        profile = self.get_profile(voice_profile_id)
        if not profile:
            raise ValueError("Voice profile not found")

        report = json.loads(profile.readiness_report_json or "{}")
        report["deep_quality"] = {
            "status": "queued",
            "note": "Deep quality analysis is intentionally separated from enrollment so large-file profile creation cannot hang.",
            "planned_checks": ["speaker_embedding_verification", "asr_backcheck", "segment_level_scoring"],
        }
        profile.readiness_report_json = json.dumps(report)
        self.db.add(profile)
        self.db.commit()
        self.db.refresh(profile)
        return profile

    def _ensure_default_user(self) -> User:
        user = self.db.query(User).filter(User.auth_subject == "demo-user").one_or_none()
        if user:
            return user

        user = User(email="demo@vclone.local", auth_subject="demo-user", status="active")
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def create_simple_profile(
        self,
        name: str,
        transcript_text: str,
        audio_filename: str,
        audio_bytes: bytes,
        transcript_filename: str | None = None,
        transcript_bytes: bytes | None = None,
        srt_offset_ms: int = 0,
        progress_callback=None,
    ) -> VoiceProfile:
        staging_dir = Path("uploads") / "staging" / str(uuid4())
        staging_dir.mkdir(parents=True, exist_ok=True)
        audio_path = staging_dir / (audio_filename or "sample-audio.bin")
        audio_path.write_bytes(audio_bytes)

        transcript_path = None
        if transcript_bytes and transcript_filename:
            transcript_path = staging_dir / transcript_filename
            transcript_path.write_bytes(transcript_bytes)

        return self._create_profile_from_audio_path(
            name=name,
            audio_path=audio_path,
            transcript_text=transcript_text,
            transcript_path=transcript_path,
            srt_offset_ms=srt_offset_ms,
            progress_callback=progress_callback,
        )

    def create_profile_from_uploaded_file(
        self,
        name: str,
        audio_path: str,
        transcript_text: str = "",
        transcript_path: str | None = None,
        srt_offset_ms: int = 0,
        progress_callback=None,
    ) -> VoiceProfile:
        source_audio_path = Path(audio_path)
        if not source_audio_path.exists() or not source_audio_path.is_file():
            raise ValueError("Uploaded audio file not found")

        source_transcript_path = Path(transcript_path) if transcript_path else None
        if source_transcript_path and (not source_transcript_path.exists() or not source_transcript_path.is_file()):
            raise ValueError("Transcript file not found")

        return self._create_profile_from_audio_path(
            name=name,
            audio_path=source_audio_path,
            transcript_text=transcript_text,
            transcript_path=source_transcript_path,
            srt_offset_ms=srt_offset_ms,
            progress_callback=progress_callback,
        )

    def create_profile(self, enrollment_id: str, mode: str, engine_preference: str, allow_adaptation: bool) -> tuple[VoiceProfile, str]:
        enrollment = self.db.get(Enrollment, enrollment_id)
        if enrollment is None:
            raise ValueError("Enrollment not found")
        readiness = {
            "consent": True,
            "liveness": False,
            "speaker_verification": False,
            "validation_status": enrollment.status,
            "adaptation_requested": allow_adaptation,
            "mode": mode,
            "engine_preference": engine_preference,
        }
        profile = VoiceProfile(
            user_id=enrollment.user_id,
            enrollment_id=enrollment_id,
            status="ready" if enrollment.status == "validated" else "pending",
            engine_family="mock",
            base_model_version="mvp-v1",
            readiness_report_json=json.dumps(readiness),
        )
        self.db.add(profile)
        self.db.commit()
        self.db.refresh(profile)
        self.audit.log(
            actor_user_id=enrollment.user_id,
            action="voice_profile.created",
            target_type="voice_profile",
            target_id=profile.id,
            payload=readiness,
        )
        return profile, f"job_profile_{profile.id[:8]}"

    def ensure_schema(self) -> None:
        for column, definition in [
            ("name", "ALTER TABLE voice_profiles ADD COLUMN name VARCHAR(120) DEFAULT 'My Voice'"),
            ("transcript_text", "ALTER TABLE voice_profiles ADD COLUMN transcript_text TEXT DEFAULT ''"),
            ("source_audio_path", "ALTER TABLE voice_profiles ADD COLUMN source_audio_path VARCHAR(500) DEFAULT ''"),
            ("sample_audio_path", "ALTER TABLE voice_profiles ADD COLUMN sample_audio_path VARCHAR(500) DEFAULT ''"),
            ("transcript_path", "ALTER TABLE voice_profiles ADD COLUMN transcript_path VARCHAR(500)"),
        ]:
            try:
                self.db.execute(text(f"SELECT {column} FROM voice_profiles LIMIT 1"))
            except Exception:
                self.db.rollback()
                self.db.execute(text(definition))
                self.db.commit()

    def list_profiles(self) -> list[VoiceProfile]:
        return self.db.query(VoiceProfile).order_by(VoiceProfile.created_at.desc()).all()

    def get_profile(self, voice_profile_id: str) -> VoiceProfile | None:
        return self.db.get(VoiceProfile, voice_profile_id)

    def _compact_curation_report(self, report: dict | None) -> dict | None:
        if not report:
            return None
        compact = dict(report)
        selected_segments = list(compact.get("selected_segments") or [])
        rejected_segments = list(compact.get("rejected_segments") or [])
        compact["selected_segments_preview"] = selected_segments[:50]
        compact["rejected_segments_preview"] = rejected_segments[:100]
        compact["selected_segments_truncated"] = max(0, len(selected_segments) - 50)
        compact["rejected_segments_truncated"] = max(0, len(rejected_segments) - 100)
        compact.pop("selected_segments", None)
        compact.pop("rejected_segments", None)
        return compact
