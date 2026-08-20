import tempfile
import unittest
import wave
from pathlib import Path

from app.services.speaker_verification import SpeakerVerificationService


class SpeakerVerificationTests(unittest.TestCase):
    def test_embedding_audio_is_always_resampled_to_16khz(self):
        service = SpeakerVerificationService()
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "forty-eight-k.wav"
            with wave.open(str(path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(48_000)
                wav_file.writeframes(int(700).to_bytes(2, byteorder="little", signed=True) * 48_000)

            waveform = service._load_audio_tensor(str(path), object())

        self.assertEqual(service.embedding_sample_rate_hz, 16_000)
        self.assertEqual(waveform.shape[-1], 16_000)


if __name__ == "__main__":
    unittest.main()
