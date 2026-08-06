# True Voice Adoption Plan

This project now has the first implementation layer for moving beyond zero-shot prompt cloning.

## What changed

- `SanskritNormalizationService` converts Devanagari/IAST/roman Sanskrit into model-friendly phonetic text.
- `AdaptationDatasetExporter` exports curated voice profile data into a training-ready dataset.
- F5-TTS preparation scripts create a simple `metadata.csv` + `wavs/` layout for external free-GPU training.
- `F5FinetunedEngine` is registered as an adapted-engine scaffold so imported checkpoints can be tracked on a profile.
- Sanskrit benchmark fixtures are stored at `vclone/training-data/sanskrit_benchmarks.json`.

## Recommended workflow

Run from `vclone/apps/api` with the API virtualenv active.

### 1. Export adaptation dataset

```bash
python scripts/export_adaptation_dataset.py \
  --profile-id YOUR_PROFILE_ID \
  --output ../../training-runs/YOUR_PROFILE_NAME
```

The output contains:

- `dataset/wavs/*.wav`
- `dataset/metadata.jsonl`
- `dataset/metadata.csv`
- `dataset/f5tts_metadata.csv`
- `dataset/train.jsonl`
- `dataset/validation.jsonl`
- `dataset/test.jsonl`
- `dataset/manifest.json`

### 2. Prepare F5-TTS layout

```bash
python scripts/prepare_f5tts_training.py \
  --dataset ../../training-runs/YOUR_PROFILE_NAME/dataset
```

This creates `dataset/f5tts/metadata.csv` and `dataset/f5tts/wavs/`.

### 3. Train externally

Use a free GPU environment such as Kaggle or Colab. Training on Mac CPU is not realistic for high-quality adaptation.

Use the exported `wavs/` and metadata as the source dataset. The exact training command depends on the F5-TTS checkout/version you choose.

### 4. Import trained checkpoint

```bash
python scripts/import_adapted_checkpoint.py \
  --profile-id YOUR_PROFILE_ID \
  --engine f5_finetuned \
  --checkpoint /path/to/f5tts_checkpoint.safetensors \
  --config /path/to/f5tts_config.json \
  --dataset-manifest ../../training-runs/YOUR_PROFILE_NAME/dataset/manifest.json
```

### 5. Benchmark before trusting it

Compare the adapted model against VoxCPM2 using:

- English identity sentence
- Sanskrit romanized sentence
- Sanskrit IAST sentence
- Sanskrit Devanagari sentence
- mixed English + Sanskrit sentence

Do not call the model successful unless it beats VoxCPM2 in blind listening and speaker-similarity checks.

## Sanskrit data requirement

For strong Sanskrit voice adoption, add Sanskrit-heavy recordings in the same voice:

- 20 minutes: minimum useful start
- 60 minutes: better
- 2+ hours: strong

Use clean, single-speaker, no-music recordings with accurate transcripts.
