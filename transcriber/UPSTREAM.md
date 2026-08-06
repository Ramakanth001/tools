# Upstream provenance

This tool is adapted from [`Ramakanth001/Transcriber`](https://github.com/Ramakanth001/Transcriber) at commit:

```text
a8d24bc1ce1a90225d194a2db81699d50ddedf4b
```

The transcription and SRT behavior was derived from:

- `model/processors/srt_processor.py`
- `model/processors/common.py`
- `model/core.py`

The upstream repository is intentionally not embedded as a nested Git repository. Large sample media, generated transcripts, profiles, bytecode caches, training data, and fine-tuning artifacts were excluded. The adapted worker lives in `python/transcriber_worker.py` and adds a stable command-line protocol, CPU fallback, bounded chunk processing, validation, cancellation, and atomic artifacts for the web workspace.
