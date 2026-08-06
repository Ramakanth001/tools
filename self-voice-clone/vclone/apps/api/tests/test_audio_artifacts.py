import tempfile
import unittest
import wave
from pathlib import Path

from app.services.audio_artifacts import inspect_audio_artifact, validate_voxcpm_reference_audio


class AudioArtifactValidationTests(unittest.TestCase):
    def _write_wav(self, path: Path, *, sample_rate: int = 16000, channels: int = 1, duration_sec: float = 1.0, sample_value: int = 1000):
        frames = max(1, int(sample_rate * duration_sec))
        with wave.open(str(path), "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            frame = int(sample_value).to_bytes(2, byteorder="little", signed=True)
            wav_file.writeframes(frame * frames * channels)

    def test_inspect_audio_artifact_marks_missing_file(self):
        stats = inspect_audio_artifact("missing.wav")
        self.assertFalse(stats.exists)
        self.assertFalse(stats.readable)

    def test_validate_voxcpm_reference_audio_rejects_too_short_prompt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "short.wav"
            self._write_wav(path, duration_sec=1.0)
            result = validate_voxcpm_reference_audio(path, artifact_type="model_candidate")
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "reference_audio_too_short")

    def test_validate_voxcpm_reference_audio_rejects_duration_mismatch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "mismatch.wav"
            self._write_wav(path, duration_sec=5.0)
            result = validate_voxcpm_reference_audio(path, artifact_type="model_candidate", expected_duration_sec=8.0)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "duration_mismatch_extraction_bug")
