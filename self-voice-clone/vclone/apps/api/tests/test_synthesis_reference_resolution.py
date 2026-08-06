import unittest
from types import SimpleNamespace

from app.services.synthesis import SynthesisService


class SynthesisReferenceResolutionTests(unittest.TestCase):
    def _service(self):
        return object.__new__(SynthesisService)

    def test_prefers_curated_native_clone_prompt_assets(self):
        profile = SimpleNamespace(sample_audio_path="fallback.wav")
        profile_report = {
            "clone_dataset": {
                "prompt": {
                    "golden_ref_audio_path_16k": "golden-16k.wav",
                    "golden_ref_audio_path": "golden.wav",
                    "golden_ref_text": "Curated prompt text.",
                }
            }
        }

        reference_path, prompt_text = self._service()._resolve_clone_reference(profile, profile_report)

        self.assertEqual(reference_path, "golden.wav")
        self.assertEqual(prompt_text, "Curated prompt text.")

    def test_falls_back_to_native_clone_prompt_asset_when_16k_variant_missing(self):
        profile = SimpleNamespace(sample_audio_path="fallback.wav")
        profile_report = {
            "clone_dataset": {
                "prompt": {
                    "golden_ref_audio_path": "golden.wav",
                    "golden_ref_text": "Curated prompt text.",
                }
            }
        }

        reference_path, prompt_text = self._service()._resolve_clone_reference(profile, profile_report)

        self.assertEqual(reference_path, "golden.wav")
        self.assertEqual(prompt_text, "Curated prompt text.")

    def test_falls_back_to_profile_sample_audio_when_prompt_bundle_missing(self):
        profile = SimpleNamespace(sample_audio_path="fallback.wav")

        reference_path, prompt_text = self._service()._resolve_clone_reference(profile, {})

        self.assertEqual(reference_path, "fallback.wav")
        self.assertEqual(prompt_text, "")

    def test_prefers_promoted_golden_ref_over_short_pack_variant(self):
        profile = SimpleNamespace(sample_audio_path="fallback.wav")
        profile_report = {
            "clone_dataset": {
                "prompt": {
                    "golden_ref_audio_path": "promoted_candidate.wav",
                    "prompt_audio_path": "short_prompt.wav",
                    "golden_ref_text": "Promoted prompt text.",
                }
            }
        }

        reference_path, prompt_text = self._service()._resolve_clone_reference(profile, profile_report)

        self.assertEqual(reference_path, "promoted_candidate.wav")
        self.assertEqual(prompt_text, "Promoted prompt text.")


if __name__ == "__main__":
    unittest.main()
