import unittest
from types import SimpleNamespace

from app.api.v1.routes.synthesis import _audio_media_type_for_path
from app.core.config import get_settings
from app.services.mastering import AudioMasteringService
from app.services.synthesis import SynthesisService


class MasteringAndRouteTests(unittest.TestCase):
    def test_parse_float_accepts_negative_lufs_and_true_peak_values(self):
        service = AudioMasteringService()
        self.assertEqual(service._parse_float("-23.0"), -23.0)
        self.assertEqual(service._parse_float("-16.5"), -16.5)
        self.assertEqual(service._parse_float("-1.0"), -1.0)
        self.assertEqual(service._parse_float("-0.5"), -0.5)

    def test_download_media_types_follow_extension(self):
        self.assertEqual(_audio_media_type_for_path("output.wav"), "audio/wav")
        self.assertEqual(_audio_media_type_for_path("output.flac"), "audio/flac")

    def test_derived_master_is_not_fail_closed_by_default(self):
        settings = get_settings()
        self.assertFalse(settings.fail_on_derived_final_master)

    def test_native_master_request_becomes_warning_when_fail_closed_disabled(self):
        service = object.__new__(SynthesisService)
        service.settings = SimpleNamespace(fail_on_derived_final_master=False)
        self.assertFalse(service._strict_native_master_required(require_native_master=True))
        warning = service._native_master_warning_payload({"spotify": {"native_master_ok": False, "status": "packaged_but_derived"}})
        self.assertTrue(warning["requested"])
        self.assertFalse(warning["native_master_ok"])
        self.assertEqual(warning["status"], "packaged_but_derived")

    def test_native_master_can_still_be_strict_when_explicitly_configured(self):
        service = object.__new__(SynthesisService)
        service.settings = SimpleNamespace(fail_on_derived_final_master=True)
        self.assertTrue(service._strict_native_master_required(require_native_master=True))
        self.assertFalse(service._strict_native_master_required(require_native_master=False))


if __name__ == "__main__":
    unittest.main()