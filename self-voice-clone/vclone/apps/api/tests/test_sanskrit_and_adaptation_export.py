import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.services.adaptation_dataset import AdaptationDatasetExporter
from app.services.sanskrit_normalization import SanskritNormalizationService


class SanskritAndAdaptationExportTests(unittest.TestCase):
    def test_devanagari_normalizes_to_iast_and_tts_phonetic(self):
        result = SanskritNormalizationService().normalize("सर्वे मानवाः स्वतन्त्राः")
        self.assertEqual(result.detected_script, "devanagari")
        self.assertIn("sarve", result.iast_text)
        self.assertIn("maanavaah", result.tts_phonetic_text)
        self.assertIn("svatantraah", result.tts_phonetic_text)

    def test_iast_normalizes_long_vowels_and_retroflexes(self):
        result = SanskritNormalizationService().normalize("ātmā nityaḥ śuddhaḥ")
        self.assertEqual(result.detected_script, "iast")
        self.assertIn("aatmaa", result.tts_phonetic_text)
        self.assertIn("shuddhah", result.tts_phonetic_text)

    def test_exporter_writes_training_dataset_from_clone_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_wav = root / "sample.wav"
            self._write_minimal_wav(source_wav)
            manifest = root / "manifest.jsonl"
            manifest.write_text(
                json.dumps(
                    {
                        "audio_path": str(source_wav),
                        "text": "ātmā nityaḥ śuddhaḥ",
                        "duration_seconds": 2.5,
                        "score": 0.9,
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            profile = SimpleNamespace(id="profile123456", name="Swami Voice")
            report = {"clone_dataset": {"manifest_path": str(manifest)}}
            output = root / "export"

            result = AdaptationDatasetExporter().export_from_report(
                profile=profile,
                report=report,
                output_dir=str(output),
                min_seconds=1.0,
                max_seconds=5.0,
            )

            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["record_count"], 1)
            metadata = output / "dataset" / "metadata.jsonl"
            row = json.loads(metadata.read_text(encoding="utf-8").strip())
            self.assertIn("aatmaa", row["text_tts_phonetic"])
            self.assertTrue((output / "dataset" / "wavs" / "000001.wav").exists())
            self.assertTrue((output / "dataset" / "f5tts_metadata.csv").exists())

    def _write_minimal_wav(self, path: Path) -> None:
        import math
        import wave
        import struct

        sample_rate = 16000
        seconds = 2.5
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            for index in range(int(sample_rate * seconds)):
                value = int(1000 * math.sin(2 * math.pi * 220 * index / sample_rate))
                wav.writeframes(struct.pack("<h", value))


if __name__ == "__main__":
    unittest.main()
