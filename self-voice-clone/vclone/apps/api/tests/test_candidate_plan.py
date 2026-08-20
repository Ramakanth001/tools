import unittest
from types import SimpleNamespace

from app.services.synthesis import SynthesisService


class _FakeEngine:
    def runtime_status(self):
        return {"available": False}


class _FakeRegistry:
    def get_engine_by_name(self, _name):
        return _FakeEngine()


class CandidatePlanTests(unittest.TestCase):
    def _service(self):
        service = object.__new__(SynthesisService)
        service.settings = SimpleNamespace(
            synthesis_preview_candidate_limit=3,
            synthesis_final_candidate_limit=2,
            voxcpm_enable_ultimate=False,
            synthesis_enable_chatterbox_bakeoff=False,
        )
        service.engine_registry = _FakeRegistry()
        return service

    def test_preview_plan_excludes_ultimate_by_default_and_prefers_native_prompt(self):
        report = {
            "clone_dataset": {
                "prompt": {
                    "candidate_prompts": [
                        {"rank": 1, "audio_path": "native.wav", "audio_path_16k": "asr.wav", "text": "Exact prompt."}
                    ]
                }
            }
        }

        plan = self._service()._build_candidate_plan("voxcpm2", report, "fallback.wav", "Fallback text", "preview")

        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["clone_mode"], "reference_only")
        self.assertEqual(plan[0]["speaker_wav"], "native.wav")

    def test_preview_plan_falls_back_to_native_prompt_when_16k_variant_missing(self):
        report = {
            "clone_dataset": {
                "prompt": {
                    "candidate_prompts": [
                        {"rank": 1, "audio_path": "native.wav", "audio_path_16k": "", "text": "Exact prompt."}
                    ]
                }
            }
        }

        plan = self._service()._build_candidate_plan("voxcpm2", report, "fallback.wav", "Fallback text", "preview")

        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["speaker_wav"], "native.wav")

    def test_ultimate_clone_is_first_when_exact_prompt_mode_is_enabled(self):
        service = self._service()
        service.settings.voxcpm_enable_ultimate = True
        report = {
            "clone_dataset": {
                "prompt": {
                    "candidate_prompts": [
                        {
                            "rank": 1,
                            "audio_path": "native.wav",
                            "audio_path_16k": "asr.wav",
                            "text": "The exact spoken prompt.",
                            "safe_for_prompt": True,
                            "asr_wer": 0.0,
                            "asr_confidence": 0.98,
                        }
                    ]
                }
            }
        }

        plan = service._build_candidate_plan("voxcpm2", report, "fallback.wav", "Fallback text", "preview")

        self.assertEqual(plan[0]["clone_mode"], "ultimate")
        self.assertEqual(plan[0]["prompt_text"], "The exact spoken prompt.")
        self.assertEqual(plan[1]["clone_mode"], "reference_only")


if __name__ == "__main__":
    unittest.main()
