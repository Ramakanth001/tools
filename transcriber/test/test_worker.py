import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock


WORKER_PATH = Path(__file__).resolve().parents[1] / "python" / "transcriber_worker.py"
SPEC = importlib.util.spec_from_file_location("transcriber_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(worker)


class FakeCuda:
    @staticmethod
    def is_available():
        return False


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, file_path, **options):
        self.calls.append((file_path, options))
        return {"segments": [{"start": 0.0, "end": 2.25, "text": " hello   world "}]}


class FakeQwenModel:
    def transcribe(self, **_options):
        timestamp = types.SimpleNamespace(text="quality result", start_time=0.5, end_time=2.5)
        return [types.SimpleNamespace(text="quality result", time_stamps=types.SimpleNamespace(items=[timestamp]))]


class WorkerTests(unittest.TestCase):
    def tearDown(self):
        worker.reset_cancel_state()

    def test_srt_timestamp_rounds_and_carries(self):
        self.assertEqual(worker.format_srt_timestamp(59.9996), "00:01:00,000")
        self.assertEqual(worker.format_srt_timestamp(3661.125), "01:01:01,125")
        self.assertEqual(worker.format_srt_timestamp(-1), "00:00:00,000")

    def test_renderers_normalize_text_and_monotonic_times(self):
        segments = [
            {"start": 1, "end": 2, "text": " First   line "},
            {"start": 1.5, "end": 3, "text": "Second line"},
            {"start": 4, "end": 5, "text": "   "},
        ]
        srt = worker.render_srt(segments)
        self.assertIn("00:00:01,000 --> 00:00:02,000", srt)
        self.assertIn("00:00:02,000 --> 00:00:03,000", srt)
        self.assertEqual(worker.render_transcript(segments), "First line Second line")

    def test_chunked_transcription_offsets_segments_and_cleans_work_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "input.mp4"
            input_path.write_bytes(b"media")
            model = FakeModel()
            extracted = []
            progress = []

            def extract(_input, output, offset, duration):
                output.write_bytes(b"wav")
                extracted.append((offset, duration))

            result = worker.transcribe_media(
                input_path=input_path,
                output_dir=root / "artifacts",
                work_dir=root / "work",
                model_name="small",
                language="auto",
                cache_dir=root / "cache",
                chunk_seconds=600,
                model_loader=lambda _name, _device, _cache: model,
                duration_probe=lambda _path: 1250.0,
                chunk_extractor=extract,
                torch_module=types.SimpleNamespace(cuda=FakeCuda()),
                progress_callback=progress.append,
            )

            self.assertEqual(extracted, [(0.0, 600.0), (600.0, 600.0), (1200.0, 50.0)])
            self.assertEqual(len(model.calls), 3)
            self.assertEqual(result["device"], "cpu")
            self.assertEqual(result["segments"], 3)
            self.assertIn("00:10:00,000 --> 00:10:02,250", (root / "artifacts" / "transcript.srt").read_text())
            self.assertEqual((root / "artifacts" / "transcript.txt").read_text(), "hello world hello world hello world")
            self.assertFalse(any((root / "work").iterdir()))
            self.assertEqual(progress[-1]["percent"], 100)

    def test_validation_and_cancellation(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "media.wav"
            input_path.write_bytes(b"x")
            kwargs = dict(
                input_path=input_path,
                output_dir=Path(temporary) / "out",
                work_dir=Path(temporary) / "work",
                cache_dir=Path(temporary) / "cache",
                model_loader=lambda *_args: FakeModel(),
                duration_probe=lambda _path: 1.0,
                chunk_extractor=lambda *_args: None,
                torch_module=types.SimpleNamespace(cuda=FakeCuda()),
            )
            with self.assertRaises(ValueError):
                worker.transcribe_media(model_name="unknown", language="auto", **kwargs)
            with self.assertRaises(ValueError):
                worker.transcribe_media(model_name="large", language="auto", engine="qwen3-asr", **kwargs)
            with self.assertRaises(ValueError):
                worker.transcribe_media(model_name="small", language="English", **kwargs)
            worker._CANCELLED = True
            with self.assertRaises(worker.CancelledError):
                worker.transcribe_media(model_name="small", language="en", **kwargs)

    def test_qwen_quality_engine_writes_aligned_segments(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "media.wav"
            input_path.write_bytes(b"media")

            def extract(_input, output, _offset, _duration):
                output.write_bytes(b"wav")

            result = worker.transcribe_media(
                input_path=input_path,
                output_dir=root / "artifacts",
                work_dir=root / "work",
                model_name="qwen3-asr-1.7b",
                language="en",
                engine="qwen3-asr",
                cache_dir=root / "cache",
                duration_probe=lambda _path: 3.0,
                chunk_extractor=extract,
                torch_module=types.SimpleNamespace(cuda=FakeCuda()),
                qwen_model_loader=lambda _device, _cache: FakeQwenModel(),
            )

            self.assertEqual(result["segments"], 1)
            self.assertIn("00:00:00,500 --> 00:00:02,500", (root / "artifacts" / "transcript.srt").read_text())
            self.assertEqual((root / "artifacts" / "transcript.txt").read_text(), "quality result")

    def test_choose_device_prefers_the_gpu_with_most_free_memory_and_falls_back_to_cpu(self):
        cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: 2,
            mem_get_info=lambda index: [(8, 16), (12, 24)][index],
        ))
        cpu = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        with mock.patch.dict(os.environ, {"TRANSCRIBER_DEVICE": "auto"}):
            self.assertEqual(worker.choose_device(cuda), "cuda:1")
            self.assertEqual(worker.choose_device(cpu), "cpu")

    def test_choose_device_honors_manual_override(self):
        cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        with mock.patch.dict(os.environ, {"TRANSCRIBER_DEVICE": "cuda:3"}):
            self.assertEqual(worker.choose_device(cuda), "cuda:3")


if __name__ == "__main__":
    unittest.main()
