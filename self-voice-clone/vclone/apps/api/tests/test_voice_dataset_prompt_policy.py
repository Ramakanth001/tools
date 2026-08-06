import tempfile
import unittest
from pathlib import Path

from app.services.voice_dataset import DatasetRecord, VoiceDatasetBuilder


class VoiceDatasetPromptPolicyTests(unittest.TestCase):
    def test_hifi_quarantine_phrase_is_detected(self):
        builder = VoiceDatasetBuilder()
        self.assertTrue(builder._is_hifi_quarantined_prompt("The cinema also is relatively real with respect to the spectator."))

    def test_prompt_score_penalizes_quarantined_phrase(self):
        builder = VoiceDatasetBuilder()
        safe = DatasetRecord(1, "a.wav", "A safe prompt text for cloning.", 9.0, 7, 0.8, "test", "train")
        leaky = DatasetRecord(2, "b.wav", "The cinema also is relatively real with respect to the spectator.", 9.0, 10, 0.8, "test", "train")
        self.assertGreater(builder._prompt_score(safe), builder._prompt_score(leaky))


if __name__ == "__main__":
    unittest.main()