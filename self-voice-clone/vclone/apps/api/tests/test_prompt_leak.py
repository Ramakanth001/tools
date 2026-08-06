import unittest

from app.services.prompt_leak import PromptLeakDetector


class PromptLeakDetectorTests(unittest.TestCase):
    def test_rejects_with_respect_to_spectator_prefix(self):
        detector = PromptLeakDetector()
        result = detector.detect(
            prompt_text="The cinema also is relatively real with respect to the spectator.",
            target_text="O God Krishna! In the coming time of Kali age, justice will suffer.",
            observed_text="With respect to the spectator, O God Krishna, in the coming time of Kali age, justice will suffer.",
        )

        self.assertTrue(result.leaked)
        self.assertIn("with respect to the spectator", result.matched_phrases)

    def test_no_leak_when_prompt_phrase_is_in_target(self):
        detector = PromptLeakDetector()
        result = detector.detect(
            prompt_text="The cinema also is relatively real with respect to the spectator.",
            target_text="Explain the phrase with respect to the spectator in one sentence.",
            observed_text="With respect to the spectator means from the viewer's standpoint.",
        )

        self.assertFalse(result.leaked)


if __name__ == "__main__":
    unittest.main()