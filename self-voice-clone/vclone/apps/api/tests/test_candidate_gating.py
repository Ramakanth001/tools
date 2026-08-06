import tempfile
import unittest
import wave
from pathlib import Path

from app.services.candidate_gating import CandidateGateService


def _silent_wav(path: Path, seconds: float = 2.0, sample_rate: int = 16000):
    frames = int(seconds * sample_rate)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frames)


class CandidateGatingTests(unittest.TestCase):
    def test_prompt_leak_is_hard_rejection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "candidate.wav"
            _silent_wav(audio)
            gate = CandidateGateService().evaluate(
                mode="preview",
                target_text="O God Krishna! In the coming time of Kali age, justice will suffer.",
                observed_text="With respect to the spectator, O God Krishna, in the coming time of Kali age, justice will suffer.",
                prompt_text="The cinema also is relatively real with respect to the spectator.",
                audio_path=str(audio),
                backcheck={"estimated_wer": 0.1, "intelligibility_score": 0.9, "is_measured": True},
                similarity={"provider": "speechbrain_ecapa", "similarity_score": 0.9, "passed": True},
                similarity_trusted=True,
            )

            self.assertFalse(gate.passed)
            self.assertIn("prompt_leak_detected", gate.hard_reasons)

    def test_wer_one_is_hard_rejection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "candidate.wav"
            _silent_wav(audio)
            gate = CandidateGateService().evaluate(
                mode="preview",
                target_text="Hello from my personal voice model.",
                observed_text="completely wrong words",
                prompt_text="A safe prompt sentence.",
                audio_path=str(audio),
                backcheck={"estimated_wer": 1.0, "intelligibility_score": 0.0, "is_measured": True},
                similarity={"provider": "speechbrain_ecapa", "similarity_score": 0.95, "passed": True},
                similarity_trusted=True,
            )

            self.assertFalse(gate.passed)
            self.assertTrue(any(reason.startswith("wer_above_threshold") for reason in gate.hard_reasons))
            self.assertTrue(any(reason.startswith("intelligibility_below_threshold") for reason in gate.hard_reasons))

    def test_similarity_failure_is_soft_by_default_even_when_trusted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "candidate.wav"
            _silent_wav(audio)
            common_kwargs = dict(
                mode="preview",
                target_text="Hello from my personal voice model.",
                observed_text="Hello from my personal voice model.",
                prompt_text="A safe prompt sentence.",
                audio_path=str(audio),
                backcheck={"estimated_wer": 0.0, "intelligibility_score": 1.0, "is_measured": True},
                similarity={"provider": "speechbrain_ecapa", "similarity_score": 0.1, "passed": False},
            )

            trusted = CandidateGateService().evaluate(**common_kwargs, similarity_trusted=True)
            untrusted = CandidateGateService().evaluate(**common_kwargs, similarity_trusted=False)

            self.assertTrue(trusted.passed)
            self.assertNotIn("trusted_similarity_failed", trusted.hard_reasons)
            self.assertTrue(untrusted.passed)


if __name__ == "__main__":
    unittest.main()