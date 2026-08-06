# Transcriber Tool

Local audio/video transcription powered by OpenAI Whisper. The tool runs entirely on the host machine, reports chunk progress, and produces plain-text and SRT artifacts.

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

The setup command installs only the transcription runtime from `requirements-runtime.txt`. The first job for a model downloads its weights into `transcriber/.cache/whisper`; subsequent jobs reuse that cache.

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
POST /jobs                         multipart: media, model, language
GET  /jobs
GET  /jobs/:id
GET  /jobs/:id/events
POST /jobs/:id/cancel
POST /jobs/:id/delete
GET  /jobs/:id/artifacts/txt
GET  /jobs/:id/artifacts/srt
```

Models: `tiny`, `base`, `small`, `medium`, and `turbo`. The default is `small`. Language defaults to `auto`; explicit values use two- or three-letter lowercase language codes.

## Local Data and Configuration

The following paths are ignored by Git:

- `.venv/` — isolated Python runtime
- `.cache/whisper/` — downloaded model weights
- `data/incoming/` — uploads awaiting job creation
- `data/jobs/` — job metadata and completed artifacts

Uploaded media and intermediate WAV chunks are deleted whenever a job reaches a terminal state. Completed TXT/SRT files remain until their job is deleted.

Environment variables:

- `TRANSCRIBER_BOOTSTRAP_PYTHON` — compatible interpreter used by the setup script.
- `TRANSCRIBER_PYTHON` — existing prepared Python executable used at runtime.
- `TRANSCRIBER_MODEL_CACHE` — alternate Whisper model cache directory.
- `TRANSCRIBER_MAX_UPLOAD_MB` — upload limit in megabytes; defaults to `2048`.
- `HOST`, `PORT`, and `TOOLS_AUTH_TOKEN` — standard workspace server settings.

## Tests

The normal suite uses a fake transcription engine and does not download model weights:

```bash
npm run test:transcriber
```

After setup, use a short real audio file with the `tiny` model for an end-to-end local smoke test.
