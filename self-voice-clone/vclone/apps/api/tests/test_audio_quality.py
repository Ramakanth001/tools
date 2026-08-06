import math
import tempfile
import unittest
import wave
from pathlib import Path

from app.services.audio_quality import AudioQualityService


class AudioQualityServiceTests(unittest.TestCase):
    def _write_wav(self, path: Path, samples: list[int], *, sample_rate: int = 24000) -> None:
        with wave.open(str(path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(b"".join(int(sample).to_bytes(2, "little", signed=True) for sample in samples))

    def _tone(self, *, sample_rate: int = 24000, duration_sec: float = 1.0, amplitude: int = 3000) -> list[int]:
        frame_count = int(sample_rate * duration_sec)
        return [int(amplitude * math.sin(2 * math.pi * 220 * i / sample_rate)) for i in range(frame_count)]

    def test_missing_file_is_unusable_blocker(self):
        report = AudioQualityService().inspect("definitely-missing.wav")
        self.assertFalse(report.exists)
        self.assertTrue(report.is_blocking)
        self.assertEqual(report.quality_tier, "unusable")

    def test_valid_readable_wav_is_analyzed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "valid.wav"
            self._write_wav(path, self._tone(duration_sec=2.0))
            report = AudioQualityService().inspect(path)
        self.assertTrue(report.exists)
        self.assertTrue(report.readable)
        self.assertGreater(report.duration_seconds or 0, 1.9)
        self.assertGreaterEqual(report.score, 0.0)
        self.assertLessEqual(report.score, 1.0)

    def test_all_zero_audio_is_unusable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "silent.wav"
            self._write_wav(path, [0] * 24000)
            report = AudioQualityService().inspect(path)
        self.assertTrue(report.is_blocking)
        self.assertEqual(report.quality_tier, "unusable")
        self.assertIn("effectively_silent_audio", {issue.code for issue in report.issues})

    def test_low_volume_non_silent_audio_is_weak_not_unusable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "low.wav"
            self._write_wav(path, self._tone(duration_sec=2.0, amplitude=120))
            report = AudioQualityService().inspect(path)
        self.assertFalse(report.is_blocking)
        self.assertIn(report.quality_tier, {"weak", "usable"})
        self.assertTrue(report.preview_synthesis_allowed)
        self.assertIn("low_volume", {issue.code for issue in report.issues})

    def test_silence_padding_and_many_pauses_warn_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "padded.wav"
            tone = self._tone(duration_sec=1.0, amplitude=3000)
            silence = [0] * 24000
            self._write_wav(path, tone + silence + tone + silence + tone)
            report = AudioQualityService().inspect(path, context="generated", target_text="This is a generated output with several pauses.")
        codes = {issue.code for issue in report.issues}
        self.assertFalse(report.is_blocking)
        self.assertIn("silence_padding", codes)
        self.assertIn("hard_zero_gaps", codes)
        self.assertGreaterEqual(report.long_pause_count or 0, 1)

    def test_clipping_warns_but_does_not_block(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "clipped.wav"
            self._write_wav(path, [32767] * 24000)
            report = AudioQualityService().inspect(path)
        self.assertFalse(report.is_blocking)
        self.assertIn("clipping_detected", {issue.code for issue in report.issues})

    def test_narrowband_is_diagnostic_not_hard_block(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "narrow.wav"
            self._write_wav(path, self._tone(sample_rate=16000, duration_sec=2.0), sample_rate=16000)
            report = AudioQualityService().inspect(path)
        self.assertFalse(report.is_blocking)
        self.assertTrue(report.narrowband_likely)
        self.assertIn("narrowband_likely", {issue.code for issue in report.issues})

    def test_generated_output_does_not_require_asr_or_sv(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "generated.wav"
            self._write_wav(path, self._tone(duration_sec=2.0))
            report = AudioQualityService().inspect(path, context="generated", target_text="hello world from generated speech")
        self.assertTrue(report.analysis_completed)
        self.assertIsNotNone(report.active_speech_seconds)
        self.assertGreaterEqual(report.score, 0.0)
        self.assertLessEqual(report.score, 1.0)

    def test_missing_optional_loudness_tools_leave_fields_none(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "valid.wav"
            self._write_wav(path, self._tone(duration_sec=1.0))
            service = AudioQualityService()
            service.ffmpeg_path = None
            report = service.inspect(path)
        self.assertIsNone(report.integrated_lufs)
        self.assertIsNone(report.loudness_range_lu)
        self.assertIsNone(report.true_peak_db)

    def test_weak_input_recommendations_are_produced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "weak.wav"
            self._write_wav(path, self._tone(duration_sec=2.0, amplitude=120))
            service = AudioQualityService()
            report = service.inspect(path)
            recommendations = service.recommend_actions(report)
        self.assertTrue(recommendations)


if __name__ == "__main__":
    unittest.main()