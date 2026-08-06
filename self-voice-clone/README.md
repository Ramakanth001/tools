# Self Voice Clone Tool

Local personal voice enrollment and text-to-speech synthesis, integrated as the sixth tool in the shared workspace.

The tool preserves the original FastAPI pipeline for resumable uploads, audio conditioning, SRT-aligned prompt curation, profile diagnostics, VoxCPM2/Chatterbox synthesis, adaptation exports, smoke tests, and WAV/FLAC delivery. The UI is a native React tool inside the shared launcher rather than a separate Next.js application.

## Setup

Install Node dependencies from the workspace root, then create the isolated Python environment:

```bash
npm install
npm run setup:self-voice-clone
```

Python 3.11 or 3.12 plus `ffmpeg` and `ffprobe` are required. The setup installs the API, tests, quality analysis, faster-whisper, speaker verification, VoxCPM2, and Chatterbox extras. Model weights remain in the normal local model cache and may download on first use.

## Run

Start the complete workspace:

```bash
npm run dev
```

Open:

```text
http://localhost:5173/tools/self-voice-clone
```

The shared Express server proxies the versioned API without buffering uploads:

```text
GET  /api/tools/self-voice-clone/health
     /api/tools/self-voice-clone/v1/*
```

The FastAPI process listens only on `127.0.0.1:8792`. It can be started separately for backend development with `npm run dev:self-voice-clone`.

## Workflow

1. **Save Voice** creates a resumable upload session, sends the audio in chunks, optionally uploads SRT/TXT, and builds a curated profile.
2. **Saved Profiles** shows readiness, clone prompt state, diagnostics, adaptation export/preparation, and imported checkpoints.
3. **Generate** runs preview/final synthesis, polls job progress, exposes engine diagnostics, and serves WAV/FLAC output through the authenticated shared API.

VoxCPM2 is the primary prompt-audio and prompt-text clone engine. Chatterbox is the fallback. XTTS remains a legacy baseline and is not silently selected when modern engines are unavailable.

## Local Data

The migrated SQLite database and voice assets live under:

```text
vclone/apps/api/vclone.db
vclone/apps/api/uploads/
vclone/profiles/
```

These paths are ignored by Git because they contain large, personal, and potentially sensitive audio. The API is always launched with `vclone/apps/api` as its working directory so existing relative paths remain valid. The migration intentionally excludes old environments, frontend builds, bulk training media, training runs, and standalone generated-audio examples.

## Configuration

- `SELF_VOICE_CLONE_BOOTSTRAP_PYTHON` — Python 3.11/3.12 used to create the environment.
- `SELF_VOICE_CLONE_PYTHON` — prepared Python executable used at runtime.
- `SELF_VOICE_CLONE_API_PORT` — FastAPI port, default `8792`.
- `SELF_VOICE_CLONE_API_URL` — upstream URL used by the Express proxy, default `http://127.0.0.1:8792`.
- `TOOLS_AUTH_TOKEN` — protects the shared API when configured; the UI forwards it for requests and media downloads.
- Existing FastAPI settings such as `PRIMARY_TTS_ENGINE`, `VOXCPM_DEVICE`, and `CHATTERBOX_VARIANT` remain supported.

Recommended Apple Silicon defaults:

```env
PRIMARY_TTS_ENGINE=voxcpm2
VOXCPM_DEVICE=cpu
VOXCPM_ALLOW_CPU=true
CHATTERBOX_VARIANT=original
```

## Tests

```bash
npm run test:self-voice-clone
npm run build
```

The normal API suite mocks heavy model calls. A real synthesis smoke test requires installed engine dependencies and available model weights.

See [UPSTREAM.md](./UPSTREAM.md) for migration provenance and `vclone/docs/` for the detailed design and adaptation plan.
