from __future__ import annotations

from dataclasses import asdict, dataclass
import csv
import json
from pathlib import Path
import shutil
from typing import Any
import zipfile

from sqlalchemy.orm import Session

from app.models.voice_profile import VoiceProfile
from app.services.audio_artifacts import inspect_audio_artifact
from app.services.sanskrit_normalization import SanskritNormalizationService


@dataclass
class AdaptationDatasetRecord:
    index: int
    audio_path: str
    text_original: str
    text_normalized: str
    text_sanskrit_iast: str
    text_tts_phonetic: str
    duration_seconds: float
    speaker_id: str
    language_tags: list[str]
    quality_score: float
    split: str
    source_audio_path: str
    source_manifest_record: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AdaptationDatasetExporter:
    """Exports a profile's curated clone data into fine-tuning friendly layouts.

    This is intentionally engine-neutral.  F5-TTS/GPT-SoVITS adapters can consume
    this exported dataset instead of depending on the enrollment internals.
    """

    def __init__(self, db: Session | None = None) -> None:
        self.db = db
        self.sanskrit = SanskritNormalizationService()

    def export_profile(
        self,
        *,
        voice_profile_id: str,
        output_dir: str,
        min_seconds: float = 2.0,
        max_seconds: float = 18.0,
        copy_audio: bool = True,
        speaker_id: str | None = None,
    ) -> dict[str, Any]:
        if self.db is None:
            raise ValueError("A database session is required when exporting by voice_profile_id.")
        profile = self.db.get(VoiceProfile, voice_profile_id)
        if profile is None:
            raise ValueError("Voice profile not found")
        report = self._json(profile.readiness_report_json)
        return self.export_from_report(
            profile=profile,
            report=report,
            output_dir=output_dir,
            min_seconds=min_seconds,
            max_seconds=max_seconds,
            copy_audio=copy_audio,
            speaker_id=speaker_id or self._safe_speaker_id(profile.name, profile.id),
        )

    def export_from_report(
        self,
        *,
        profile: VoiceProfile,
        report: dict[str, Any],
        output_dir: str,
        min_seconds: float = 2.0,
        max_seconds: float = 18.0,
        copy_audio: bool = True,
        speaker_id: str | None = None,
    ) -> dict[str, Any]:
        root = Path(output_dir)
        dataset_dir = root / "dataset"
        wavs_dir = dataset_dir / "wavs"
        wavs_dir.mkdir(parents=True, exist_ok=True)

        source_records = self._load_clone_manifest(report)
        accepted: list[AdaptationDatasetRecord] = []
        rejected: list[dict[str, Any]] = []
        speaker = speaker_id or self._safe_speaker_id(profile.name, profile.id)

        for raw in source_records:
            rejection = self._record_rejection_reason(raw, min_seconds=min_seconds, max_seconds=max_seconds)
            if rejection:
                rejected.append({"reason": rejection, "record": raw})
                continue
            source_audio = Path(str(raw.get("audio_path") or ""))
            target_name = f"{len(accepted) + 1:06d}{source_audio.suffix or '.wav'}"
            target_audio = wavs_dir / target_name
            if copy_audio:
                shutil.copy2(source_audio, target_audio)
            else:
                target_audio = source_audio

            text_original = str(raw.get("text") or "").strip()
            sanskrit = self.sanskrit.normalize(text_original)
            tags = self._language_tags(text_original, sanskrit.detected_script)
            accepted.append(
                AdaptationDatasetRecord(
                    index=len(accepted) + 1,
                    audio_path=str(Path("wavs") / target_name) if copy_audio else str(target_audio),
                    text_original=text_original,
                    text_normalized=" ".join(text_original.split()),
                    text_sanskrit_iast=sanskrit.iast_text,
                    text_tts_phonetic=sanskrit.tts_phonetic_text,
                    duration_seconds=round(float(raw.get("duration_seconds") or 0.0), 3),
                    speaker_id=speaker,
                    language_tags=tags,
                    quality_score=float(raw.get("score") or 0.0),
                    split=str(raw.get("split") or self._split_for_index(len(accepted) + 1)),
                    source_audio_path=str(source_audio),
                    source_manifest_record=raw,
                )
            )

        accepted = self._ensure_splits(accepted)
        self._write_outputs(dataset_dir=dataset_dir, records=accepted, rejected=rejected)
        manifest = {
            "status": "ready" if accepted else "empty",
            "purpose": "speaker_adaptation_training_dataset",
            "voice_profile_id": profile.id,
            "voice_profile_name": profile.name,
            "speaker_id": speaker,
            "dataset_dir": str(dataset_dir),
            "wavs_dir": str(wavs_dir),
            "record_count": len(accepted),
            "rejected_count": len(rejected),
            "total_seconds": round(sum(row.duration_seconds for row in accepted), 3),
            "total_minutes": round(sum(row.duration_seconds for row in accepted) / 60.0, 3),
            "splits": {
                split: {
                    "count": sum(1 for row in accepted if row.split == split),
                    "seconds": round(sum(row.duration_seconds for row in accepted if row.split == split), 3),
                }
                for split in ["train", "validation", "test"]
            },
            "files": {
                "manifest_json": str(dataset_dir / "manifest.json"),
                "metadata_csv": str(dataset_dir / "metadata.csv"),
                "metadata_jsonl": str(dataset_dir / "metadata.jsonl"),
                "train_jsonl": str(dataset_dir / "train.jsonl"),
                "validation_jsonl": str(dataset_dir / "validation.jsonl"),
                "test_jsonl": str(dataset_dir / "test.jsonl"),
                "rejected_jsonl": str(dataset_dir / "rejected.jsonl"),
                "f5tts_metadata_csv": str(dataset_dir / "f5tts_metadata.csv"),
            },
            "sanskrit_policy": {
                "text_sanskrit_iast": "IAST/de-Devanagari transliteration for inspection.",
                "text_tts_phonetic": "Model-friendly phonetic romanization for Sanskrit-heavy TTS experiments.",
                "recommendation": "Record and include 20-60+ minutes of Sanskrit-heavy speech for strong Sanskrit voice adoption.",
            },
        }
        (dataset_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        return manifest

    def prepare_f5tts_layout(self, *, dataset_dir: str, output_dir: str | None = None) -> dict[str, Any]:
        dataset = Path(dataset_dir)
        output = Path(output_dir) if output_dir else dataset / "f5tts"
        output.mkdir(parents=True, exist_ok=True)
        records = [json.loads(line) for line in (dataset / "metadata.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        wavs_out = output / "wavs"
        wavs_out.mkdir(parents=True, exist_ok=True)
        metadata_rows: list[dict[str, str]] = []
        for row in records:
            src = dataset / str(row["audio_path"])
            dst = wavs_out / Path(str(row["audio_path"])).name
            if src.exists() and not dst.exists():
                shutil.copy2(src, dst)
            text = str(row.get("text_tts_phonetic") or row.get("text_normalized") or row.get("text_original") or "").strip()
            metadata_rows.append({"audio_path": str(Path("wavs") / dst.name), "text": text, "speaker_id": str(row.get("speaker_id") or "speaker")})
        with (output / "metadata.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["audio_path", "text", "speaker_id"], delimiter="|")
            writer.writeheader()
            writer.writerows(metadata_rows)
        readme = output / "README.md"
        readme.write_text(
            "# F5-TTS adaptation dataset\n\n"
            "This folder is prepared for external/free GPU fine-tuning. Use the generated `metadata.csv` "
            "and `wavs/` as the source dataset. Exact F5-TTS training commands depend on the F5-TTS checkout/version.\n\n"
            "Use `text_tts_phonetic` for Sanskrit-heavy experiments and compare against `text_normalized` if pronunciation is poor.\n",
            encoding="utf-8",
        )
        (output / "train_config_template.yaml").write_text(
            "# F5-TTS fine-tuning template\n"
            "# Adjust paths/arguments for the exact F5-TTS repository version you use.\n"
            f"dataset_dir: {output}\n"
            "metadata: metadata.csv\n"
            "audio_dir: wavs\n"
            "text_column: text\n"
            "speaker_column: speaker_id\n"
            "recommended_first_run:\n"
            "  max_steps: 2000\n"
            "  save_every: 500\n"
            "  validate_every: 500\n"
            "  learning_rate: low\n"
            "notes:\n"
            "  - Start with a short run to verify pronunciation and identity.\n"
            "  - For Sanskrit, compare text_tts_phonetic against text_normalized if output sounds unnatural.\n",
            encoding="utf-8",
        )
        (output / "colab_train_instructions.md").write_text(self._free_gpu_instructions(platform="Colab"), encoding="utf-8")
        (output / "kaggle_train_instructions.md").write_text(self._free_gpu_instructions(platform="Kaggle"), encoding="utf-8")
        zip_path = output.parent / "f5tts_training_package.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in output.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(output.parent))
        return {
            "status": "ready",
            "output_dir": str(output),
            "record_count": len(metadata_rows),
            "metadata_csv": str(output / "metadata.csv"),
            "zip_path": str(zip_path),
            "free_gpu_guides": {
                "colab": str(output / "colab_train_instructions.md"),
                "kaggle": str(output / "kaggle_train_instructions.md"),
            },
        }

    def _load_clone_manifest(self, report: dict[str, Any]) -> list[dict[str, Any]]:
        clone = report.get("clone_dataset") or {}
        manifest_path = Path(str(clone.get("manifest_path") or ""))
        if manifest_path.exists():
            return [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        records = list((clone.get("prompt") or {}).get("prompt_records") or [])
        if records:
            return records
        return []

    def _record_rejection_reason(self, raw: dict[str, Any], *, min_seconds: float, max_seconds: float) -> str | None:
        audio = Path(str(raw.get("audio_path") or ""))
        if not audio.exists() or not audio.is_file():
            return "audio_missing"
        text = str(raw.get("text") or "").strip()
        if len(text.split()) < 2:
            return "text_too_short"
        duration = float(raw.get("duration_seconds") or 0.0)
        if duration < min_seconds:
            return "duration_too_short"
        if duration > max_seconds:
            return "duration_too_long"
        stats = inspect_audio_artifact(audio)
        if not stats.readable or not stats.duration_sec:
            return "audio_unreadable"
        return None

    def _write_outputs(self, *, dataset_dir: Path, records: list[AdaptationDatasetRecord], rejected: list[dict[str, Any]]) -> None:
        rows = [record.to_dict() for record in records]
        self._write_jsonl(dataset_dir / "metadata.jsonl", rows)
        self._write_jsonl(dataset_dir / "train.jsonl", [row for row in rows if row["split"] == "train"])
        self._write_jsonl(dataset_dir / "validation.jsonl", [row for row in rows if row["split"] == "validation"])
        self._write_jsonl(dataset_dir / "test.jsonl", [row for row in rows if row["split"] == "test"])
        self._write_jsonl(dataset_dir / "rejected.jsonl", rejected)
        with (dataset_dir / "metadata.csv").open("w", newline="", encoding="utf-8") as handle:
            fieldnames = ["audio_path", "text_original", "text_tts_phonetic", "duration_seconds", "speaker_id", "split"]
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                writer.writerow({key: row[key] for key in fieldnames})
        with (dataset_dir / "f5tts_metadata.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle, delimiter="|")
            writer.writerow(["audio_path", "text", "speaker_id"])
            for row in rows:
                writer.writerow([row["audio_path"], row["text_tts_phonetic"], row["speaker_id"]])

    def _write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> None:
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")

    def _ensure_splits(self, records: list[AdaptationDatasetRecord]) -> list[AdaptationDatasetRecord]:
        if len(records) < 10:
            return records
        for position, record in enumerate(records, start=1):
            record.split = self._split_for_index(position)
        return records

    def _split_for_index(self, index: int) -> str:
        if index % 20 == 0:
            return "test"
        if index % 10 == 0:
            return "validation"
        return "train"

    def _language_tags(self, text: str, detected_script: str) -> list[str]:
        tags = ["en"]
        if detected_script in {"devanagari", "iast", "roman_sanskrit_hint"}:
            tags.append("sa-Latn" if detected_script != "devanagari" else "sa-Deva")
        return tags

    def _safe_speaker_id(self, name: str, profile_id: str) -> str:
        slug = "_".join(re for re in "".join(ch.lower() if ch.isalnum() else " " for ch in (name or "voice")).split() if re)
        return f"{slug or 'voice'}_{profile_id[:8]}"

    def _json(self, value: str | None) -> dict[str, Any]:
        try:
            return json.loads(value or "{}")
        except Exception:
            return {}

    def _free_gpu_instructions(self, *, platform: str) -> str:
        return f"""# {platform} F5-TTS free-GPU training instructions

This package is generated by `self-voice-clone` for true voice adoption.

## Files

- `metadata.csv` — pipe-delimited `audio_path|text|speaker_id` records.
- `wavs/` — adaptation clips.
- `train_config_template.yaml` — conservative starting config notes.

## High-level workflow

1. Create a free GPU notebook/session in {platform}.
2. Upload `f5tts_training_package.zip` or the full `f5tts/` folder.
3. Install the F5-TTS repository/version you choose.
4. Point its fine-tuning script at `metadata.csv` and `wavs/`.
5. Start with a short sanity run before a long run.
6. Generate the Sanskrit benchmark sentences after each checkpoint.
7. Download the best checkpoint and config.
8. Import it back into this app with `scripts/import_adapted_checkpoint.py`.

## Quality rule

Do not make the adapted model the default until it beats VoxCPM2 on blind listening and speaker-similarity checks.

## Sanskrit note

For best Sanskrit voice adoption, add 20–60+ minutes of Sanskrit-heavy clean recordings and re-export this dataset.
"""
