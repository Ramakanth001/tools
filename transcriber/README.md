# Transcriber Tool

Local audio/video transcription powered by OpenAI Whisper and Qwen3-ASR. The tool runs entirely on the host machine, reports chunk progress, produces plain-text and SRT artifacts, and can extract MP3 audio from a video.

The adapted upstream source and pinned revision are documented in [UPSTREAM.md](./UPSTREAM.md).

## Setup

Install Node dependencies from the workspace root, then create the isolated Python environment:

```bash
npm install
npm run setup:transcriber
```

Python 3.11 or 3.12 and the `ffmpeg`/`ffprobe` executables are required. On macOS:

```bash
brew install python@3.11 ffmpeg
```

The setup command installs the local transcription runtime from `requirements.txt`, which includes the detailed pins in `requirements-runtime.txt`. The first job for a model downloads its weights into the ignored `transcriber/.cache/whisper` cache; Qwen3-ASR uses the nested Hugging Face cache. Subsequent jobs reuse the local weights.

## Run

Standalone development:

```bash
npm run dev:transcriber
```

- UI: `http://localhost:5177`
- API: `http://localhost:8791/api`

Shared workspace:

```bash
npm run dev
```

Open `http://localhost:5173/tools/transcriber`.

## API

The standalone base path is `/api`; the shared-host base path is `/api/tools/transcriber`.

```text
GET  /health
POST /jobs                         multipart: media, operation, engine, model, language
GET  /jobs
GET  /jobs/:id
GET  /jobs/:id/events
POST /jobs/:id/cancel
POST /jobs/:id/delete
GET  /jobs/:id/artifacts/txt
GET  /jobs/:id/artifacts/srt
GET  /jobs/:id/artifacts/audio
```

Operations: `transcribe` (default) and `extract_audio`. Audio extraction produces a high-quality MP3 from the first audio stream and does not load an ASR model.

Engines and models:

- `whisper` (default): `tiny`, `base`, `small`, `medium`, `large`, and `turbo`. `large` is Whisper `large-v3`, the highest-accuracy Whisper model; it needs roughly 10 GB of VRAM for practical GPU use.
- `qwen3-asr`: `qwen3-asr-1.7b`, the quality-first local alternative. It downloads the Qwen3-ASR 1.7B model plus its forced aligner for accurate SRT timestamps. It requires substantial memory and is much slower without CUDA.

Language defaults to `auto`; explicit values use two- or three-letter lowercase language codes. Qwen3-ASR auto-detects supported languages; the UI's common language choices are mapped to its native language names.

Chunk length defaults to 10 minutes and can be set from 1 to 60 minutes per transcription. Shorter chunks reduce peak memory use and make cancellation reach a boundary sooner; longer chunks reduce boundary transitions but need more RAM/VRAM. The worker automatically chooses the available CUDA GPU with the most free memory. Set `TRANSCRIBER_DEVICE=cpu` or `TRANSCRIBER_DEVICE=cuda:1` to override that choice.

## Local Data and Configuration

The following paths are ignored by Git:

- `.venv/` — isolated Python runtime
- `.cache/whisper/` — downloaded Whisper and Qwen3-ASR model weights
- `data/incoming/` — uploads awaiting job creation
- `data/jobs/` — job metadata and completed artifacts

Uploaded media and intermediate WAV chunks are deleted whenever a job reaches a terminal state. Completed TXT/SRT or extracted MP3 files remain until their job is deleted.

Environment variables:

- `TRANSCRIBER_BOOTSTRAP_PYTHON` — compatible interpreter used by the setup script.
- `TRANSCRIBER_PYTHON` — existing prepared Python executable used at runtime.
- `TRANSCRIBER_MODEL_CACHE` — alternate Whisper model cache directory.
- `TRANSCRIBER_MAX_UPLOAD_MB` — upload limit in megabytes; defaults to `2048`.
- `TRANSCRIBER_DEVICE` — `auto` (default), `cpu`, or a CUDA device such as `cuda:1`.
- `HOST`, `PORT`, and `TOOLS_AUTH_TOKEN` — standard workspace server settings.

## Tests

The normal suite uses a fake transcription engine and does not download model weights:

```bash
npm run test:transcriber
```

After setup, use a short real audio file with the `tiny` model for a quick end-to-end smoke test. The `large` and Qwen3-ASR models download several GB on first use.
