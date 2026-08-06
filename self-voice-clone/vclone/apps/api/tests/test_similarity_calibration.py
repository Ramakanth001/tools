import tempfile
import unittest
import wave
from pathlib import Path

from app.services.similarity_calibration import SimilarityCalibrationService


def _silent_wav(path: Path, seconds: float = 1.0, sample_rate: int = 16000):
    frames = int(seconds * sample_rate)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frames)


class SimilarityCalibrationTests(unittest.TestCase):
    def test_calibration_returns_structured_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ref.wav"
            _silent_wav(path)
            result = SimilarityCalibrationService().calibrate(golden_ref_path=str(path))
            payload = result.to_dict()
            self.assertIn("trusted", payload)
            self.assertIn("provider", payload)
            self.assertIn("self_similarity_score", payload)


if __name__ == "__main__":
    unittest.main()