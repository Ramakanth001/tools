# Implementation Plan

[Overview]
Implement a local/open-source quality-hardening pass that turns the current voice-clone MVP into a measurable pipeline for diagnosing weak input audio, selecting better reference prompts, improving synthesis gates, and reporting realistic quality limits.

The existing project is a FastAPI + Next.js local MVP with SQLite/local-file storage, resumable upload support, SRT-based curation, VoxCPM2 as the preferred clone engine, Chatterbox as fallback, XTTS as legacy baseline, and WAV/FLAC mastering/export. The code already contains useful scaffolding for curation, prompt-bank creation, candidate smoke tests, ASR back-checks, speaker verification, mastering, and UI diagnostics, but several parts are heuristic, incomplete, or internally inconsistent.

The main open issues are: weak-input preprocessing is mostly loudness normalization plus basic silence handling; SRT curation detects speech bounds but extracts padded subtitle windows rather than the detected speech spans; deep quality checks are only marked as queued; speaker verification and ASR fallbacks can look more trustworthy than they are; long-form synthesis can bypass stronger candidate smoke tests; mastering loudness parsing currently rejects negative LUFS/true-peak values; FLAC/non-WAV evaluation falls back to a weak artifact score; UI copy still says output is mocked/XTTS-centric in places; and the local environment is not reproducible because pytest and API dependencies were missing in the active Python environment during investigation.

There is a real possibility to improve output quality despite weak input, but only within physical limits. The best local/open-source improvements are: preserve the raw upload, measure quality explicitly, isolate the cleanest single-speaker segments, generate cautious enhancement candidates, reject over-processed derivatives, build a diverse prompt bank, choose reference candidates by actual acoustic/ASR/speaker metrics, and gate each generated chunk. Mastering can make delivery cleaner and more consistent, but it cannot reconstruct missing speaker identity, fix severe clipping, remove overlapping speakers perfectly, or make a poor clone sound like a studio-grade voice without enough usable source speech.

[Types]
Add explicit quality, enhancement, segment, prompt, and synthesis-gate types so every module can distinguish measured evidence from heuristic fallbacks.

Detailed type/data-structure requirements:

```python
# app/services/audio_quality.py
AudioIssueCode = Literal[
    "missing_file", "decode_failed", "too_short", "too_silent", "low_snr",
    "clipping_detected", "near_clipping", "narrowband_audio", "dc_offset",
    "excessive_silence", "music_or_noise_suspected", "multi_speaker_suspected",
    "srt_timing_mismatch", "reference_prompt_invalid", "enhancement_overprocessed",
]

@dataclass
class AudioQualityIssue:
    code: AudioIssueCode
    severity: Literal["info", "warning", "blocker"]
    message: str
    evidence: dict[str, Any]
    recommended_action: str

@dataclass
class AudioQualityReport:
    path: str
    exists: bool
    readable: bool
    duration_seconds: float
    sample_rate_hz: int | None
    channels: int | None
    bits_per_sample: int | None
    mean_volume_db: float | None
    peak_dbfs: float | None
    integrated_lufs: float | None
    true_peak_db: float | None
    rms_dbfs: float | None
    noise_floor_dbfs: float | None
    estimated_snr_db: float | None
    clipping_ratio: float
    silence_ratio: float
    non_silent_seconds: float | None
    narrowband_likely: bool
    enhancement_recommended: bool
    conditioning_allowed: bool
    adaptation_allowed: bool
    score: float
    issues: list[AudioQualityIssue]
```

Validation rules: `duration_seconds` must be non-negative; `score` must be bounded to `[0.0, 1.0]`; `conditioning_allowed` must be false for unreadable, all-zero, too-short, or mostly-silent audio; `adaptation_allowed` must require materially more clean speech than zero-shot prompting; all measured fields must remain `None` when the underlying tool is unavailable rather than being replaced by fake values.

```python
# app/services/audio_enhancement.py
@dataclass
class AudioEnhancementCandidate:
    profile: Literal["raw", "light_denoise", "voice_band_cleanup", "declick_declip", "vad_trimmed"]
    source_path: str
    output_path: str
    command: list[str]
    before: AudioQualityReport
    after: AudioQualityReport
    score_delta: float
    accepted: bool
    rejection_reason: str | None
```

Validation rules: never overwrite the raw upload; never accept an enhanced candidate if non-silent duration drops below 85% of the selected source or if ASR confidence/speaker similarity degrades; keep enhancement profiles conservative by default.

```python
# app/services/segment_quality.py
@dataclass
class SegmentQualityReport:
    index: int
    audio_path: str
    text: str
    source_start_sec: float | None
    source_end_sec: float | None
    duration_seconds: float
    detected_speech_seconds: float | None
    speech_coverage_percent: float | None
    asr_provider: str
    asr_measured: bool
    asr_wer: float | None
    speaker_provider: str
    speaker_measured: bool
    speaker_similarity: float | None
    acoustic_score: float
    text_score: float
    prompt_score: float
    passed: bool
    rejection_reasons: list[str]
```

Validation rules: reject prompt candidates shorter than `voice_prompt_min_seconds`, longer than `voice_prompt_max_seconds`, mostly silent, unreadable, non-finite, transcript-empty, or duration-mismatched beyond configured tolerance.

```python
# app/services/deep_quality.py
@dataclass
class DeepQualityReport:
    status: Literal["pending", "running", "completed", "failed"]
    voice_profile_id: str
    started_at: str | None
    completed_at: str | None
    source_audio_quality: dict[str, Any]
    conditioning_audio_quality: dict[str, Any]
    segment_summary: dict[str, Any]
    prompt_summary: dict[str, Any]
    speaker_consistency: dict[str, Any]
    asr_alignment: dict[str, Any]
    publish_blockers: list[str]
    recommendations: list[str]
```

```python
# app/services/synthesis_quality.py or app/services/candidate_gating.py extension
@dataclass
class SynthesisChunkQualityResult:
    chunk_index: int
    target_text: str
    audio_path: str
    asr_provider: str
    asr_measured: bool
    observed_text: str
    wer: float | None
    prompt_leak: dict[str, Any]
    speaker_similarity: float | None
    speaker_measured: bool
    artifact_score: float
    duration_ratio: float | None
    passed: bool
    hard_reasons: list[str]
```

Frontend TypeScript additions in `vclone/apps/web/lib/api.ts` should mirror these reports with `AudioQualityReport`, `DeepQualityReport`, `SegmentQualitySummary`, and `SynthesisQualitySummary` types, using `Record<string, unknown>` only for opaque nested diagnostic payloads.

[Files]
Modify backend quality/enrollment/synthesis modules, frontend diagnostics, tests, docs, and local environment configuration without introducing cloud or paid services.

New files to be created:

- `vclone/apps/api/app/services/audio_quality.py`: central FFmpeg/soundfile/wave-based source, segment, and delivery audio inspection service.
- `vclone/apps/api/app/services/audio_enhancement.py`: conservative local enhancement-candidate generator using FFmpeg filters first, optional Python packages only when installed.
- `vclone/apps/api/app/services/segment_quality.py`: segment-level scoring for SRT extraction, prompt ranking, and adaptation readiness.
- `vclone/apps/api/app/services/deep_quality.py`: actual deep quality runner that updates `VoiceProfile.readiness_report_json` instead of only marking checks as queued.
- `vclone/apps/api/app/services/synthesis_quality.py`: shared per-chunk post-render quality checks, reusable by preview and final synthesis.
- `vclone/apps/api/app/schemas/quality.py`: Pydantic response models for quality reports and deep quality runs.
- `vclone/apps/api/tests/test_audio_quality.py`: unit tests for silence, clipping, duration, and decode handling.
- `vclone/apps/api/tests/test_audio_enhancement.py`: tests that enhancement candidates preserve duration and reject over-processing.
- `vclone/apps/api/tests/test_deep_quality.py`: tests for real report updates without invoking heavy models.
- `vclone/apps/api/tests/test_mastering_loudness.py`: regression tests for negative LUFS/true-peak parsing and WAV/FLAC delivery reports.
- `vclone/apps/api/tests/test_segment_quality.py`: tests for prompt candidate scoring and rejection reasons.
- `vclone/apps/api/tests/test_synthesis_quality.py`: tests for per-chunk quality gate behavior with mocked ASR/SV reports.

Existing files to be modified:

- `vclone/apps/api/pyproject.toml`: add local dev/test extras and optional local audio-quality extras; do not move cloud dependencies into the plan.
- `.gitignore`: ignore generated `.next/`, local `uploads/`, generated WAV/FLAC artifacts, diagnostics/profiles/training data if they are not intended source fixtures.
- `README.md`: replace stale “mocked output”/XTTS-first language with current VoxCPM2/Chatterbox local pipeline and honest weak-input guidance.
- `vclone/docs/personal-voice-clone-tts-design.md`: add current gap analysis and local-only implementation notes where the design diverges from the MVP.
- `vclone/apps/api/app/core/config.py`: add thresholds for source-quality gates, enhancement profiles, detected-bound padding, deep-quality behavior, local test mode, and synthesis gate trust requirements.
- `vclone/apps/api/app/services/audio_processing.py`: call `AudioQualityService` before/after conditioning; generate and select enhancement candidates; fail with actionable reasons instead of silently copying unreadable files.
- `vclone/apps/api/app/services/audio_segmenter.py`: extract detected speech bounds rather than broad SRT windows, compute selected duration from extracted files, handle overlaps/offsets explicitly, and surface timing-mismatch reasons.
- `vclone/apps/api/app/services/voice_dataset.py`: rank prompts with segment-quality reports, diversity, ASR confidence, acoustic quality, duration correctness, and prompt-leak risk; mark prompt-not-ready instead of accepting weak fallback prompts as equivalent.
- `vclone/apps/api/app/services/voice_profiles.py`: persist source/conditioning quality reports, enhancement decisions, real deep-quality results, and stricter readiness status.
- `vclone/apps/api/app/services/synthesis.py`: apply consistent candidate smoke tests for short and long form, run per-chunk gates, improve partial/resume metadata, and use correct output media type.
- `vclone/apps/api/app/services/clone_engines.py`: validate generated output artifacts after each engine call, expose generation parameters in reports, and enable VoxCPM2 ultimate mode only after smoke tests prove no prompt leakage.
- `vclone/apps/api/app/services/mastering.py`: fix negative float parsing, use configured mastering settings, improve loudness/true-peak reporting, and correctly describe mono/derived output.
- `vclone/apps/api/app/services/evaluation.py`: replace WAV-only artifact scoring with `AudioQualityService`/soundfile/ffprobe metrics that work for FLAC and WAV.
- `vclone/apps/api/app/services/asr_backcheck.py`: distinguish measured ASR from fallback placeholders in a typed way and expose release-blocker trust state.
- `vclone/apps/api/app/services/speaker_verification.py`: mark duration fallback as untrusted; never let duration-only similarity masquerade as real speaker verification.
- `vclone/apps/api/app/api/v1/routes/voice_profiles.py`: make `/deep-quality-check` actually execute or enqueue the local deep-quality runner and return updated report state.
- `vclone/apps/api/app/api/v1/routes/synthesis.py`: return correct media type for WAV vs FLAC and include terminal failure details consistently.
- `vclone/apps/api/app/api/v1/routes/system.py`: include quality-tool availability (`ffmpeg`, `ffprobe`, `soundfile`, optional enhancement packages, pytest/dev extras not at runtime).
- `vclone/apps/web/lib/api.ts`: add typed quality report fields and use API fetch/error handling consistently for profile list/system calls.
- `vclone/apps/web/app/page.tsx`: remove stale “current output is mocked” and XTTS-first wording.
- `vclone/apps/web/app/enrollment/page.tsx`: display source-quality warnings, enhancement decisions, prompt-readiness blockers, and “record better input” guidance.
- `vclone/apps/web/app/voices/page.tsx`: show deep-quality status, source score, prompt score, and hard blockers.
- `vclone/apps/web/app/synthesis/page.tsx`: show measured-vs-heuristic badges for ASR/SV, candidate selection, per-chunk quality, and final delivery truthfulness.

Files to be deleted or moved:

- Do not delete user audio automatically. If generated demo WAVs and local profiles should not be versioned, add ignore rules and move long-term examples into a clearly named `fixtures/` folder only if the user confirms.
- No production source files should be removed in this pass.

Configuration file updates:

- Add optional dependency groups in `pyproject.toml`: `dev`, `quality`, and optionally `vad`, all local/open-source.
- Add documented `.env` knobs for quality thresholds, enhancement enablement, and fail-closed behavior.
- Align `SynthesisRequest.require_native_master` defaults with README/config behavior.

[Functions]
Add measured-quality functions and modify existing enrollment/synthesis functions so quality decisions are evidence-based rather than heuristic-only.

New functions:

- `AudioQualityService.inspect(input_path: str | Path, *, max_analysis_seconds: int | None = None) -> AudioQualityReport` in `audio_quality.py`: inspect decoded audio, loudness, silence, clipping, non-silent duration, SNR proxy, and blockers.
- `AudioQualityService.compare(before_path: str | Path, after_path: str | Path) -> dict[str, Any]` in `audio_quality.py`: compare raw vs enhanced derivatives and flag degradation.
- `AudioQualityService.recommend_actions(report: AudioQualityReport) -> list[str]` in `audio_quality.py`: return user-facing fixes such as “record closer to microphone”, “remove background music”, or “provide SRT”.
- `AudioEnhancementService.build_candidates(input_path: str, output_dir: str, *, source_report: AudioQualityReport) -> list[AudioEnhancementCandidate]` in `audio_enhancement.py`: create raw/light-denoise/cleanup candidates locally.
- `AudioEnhancementService.select_best(candidates: list[AudioEnhancementCandidate]) -> AudioEnhancementCandidate` in `audio_enhancement.py`: choose the best accepted candidate with conservative scoring.
- `SegmentQualityService.score_segment(...) -> SegmentQualityReport` in `segment_quality.py`: score one extracted SRT/ASR segment.
- `SegmentQualityService.rank_prompt_candidates(records: list[DatasetRecord]) -> list[SegmentQualityReport]` in `segment_quality.py`: centralize prompt ranking.
- `DeepQualityService.run_profile_check(voice_profile_id: str, *, progress_callback=None) -> VoiceProfile` in `deep_quality.py`: run source, conditioning, segment, prompt, ASR, and speaker consistency checks.
- `SynthesisQualityService.evaluate_chunk(...) -> SynthesisChunkQualityResult` in `synthesis_quality.py`: run ASR/prompt-leak/speaker/artifact/duration checks per generated chunk.
- `SynthesisQualityService.aggregate(results: list[SynthesisChunkQualityResult]) -> dict[str, Any]` in `synthesis_quality.py`: produce job-level quality summary.
- `AudioSegmenterService._bounds_for_extraction(segment: SRTSegment, speech_analysis: dict, audio_duration_seconds: float) -> tuple[float, float, str]` in `audio_segmenter.py`: choose detected speech bounds plus padding, falling back to SRT only when detection is untrusted.
- `AudioMasteringService.media_type_for_format(audio_format: str) -> str` in `mastering.py` or route helper: return `audio/wav` or `audio/flac`.

Modified functions:

- `AudioProcessingService.process_for_conditioning(...)` in `audio_processing.py`: inspect raw input, optionally build enhancement candidates, keep raw path, store selected derivative, and return quality metadata.
- `AudioProcessingService._guidance_for_duration(...)` in `audio_processing.py`: incorporate non-silent duration and source score, not only total duration.
- `AudioSegmenterService.curate_from_srt(...)` in `audio_segmenter.py`: use detected bounds for extraction, update `selected_duration_seconds` from actual extracted speech, keep full rejected reasons, and avoid treating broad subtitle display time as clean speech.
- `AudioSegmenterService._detect_speech_bounds(...)` in `audio_segmenter.py`: add confidence/reason fields so extraction can decide whether detected bounds are safe.
- `VoiceDatasetBuilder._records_from_selected_segments(...)` in `voice_dataset.py`: attach segment quality reports and reject low-confidence SRT/text/audio pairs.
- `VoiceDatasetBuilder._build_prompt_artifacts(...)` in `voice_dataset.py`: choose prompts by measured quality/diversity and avoid weak fallback prompt equivalence.
- `VoiceDatasetBuilder._segment_score(...)` and `_prompt_score(...)` in `voice_dataset.py`: include clipping, silence ratio, SNR proxy, speaker consistency, and ASR trust.
- `VoiceProfileService._create_profile_from_audio_path(...)` in `voice_profiles.py`: store raw quality, selected enhancement, conditioning quality, segment-quality summary, and stricter readiness.
- `VoiceProfileService.start_deep_quality_check(...)` in `voice_profiles.py`: call `DeepQualityService` or a local background wrapper instead of only setting status to queued.
- `SynthesisService.create_job(...)` in `synthesis.py`: reject final/native-master mismatches consistently, persist quality policy, and warn when profile quality is weak.
- `SynthesisService._run_isolated_engine_job(...)` in `synthesis.py`: run candidate smoke tests for long form too, at least on the locked candidate; run per-chunk gates or scheduled sample gates for long text.
- `SynthesisService._build_candidate_plan(...)` in `synthesis.py`: include quality metadata, enhancement profile, prompt score, leak risk, and engine-specific clone mode.
- `SynthesisService.get_generated_file_path(...)` or `download_generated_file(...)`: ensure correct media type and filename extension.
- `VoxCPM2Engine.synthesize(...)` in `clone_engines.py`: validate output duration/readability, include actual output stats, and only use ultimate prompt mode when candidate policy allows it.
- `ChatterboxEngine.synthesize(...)` in `clone_engines.py`: validate prompt audio with same artifact rules and return output stats.
- `AudioMasteringService._parse_float(...)` in `mastering.py`: accept negative LUFS and true-peak values; currently negative values are discarded.
- `AudioMasteringService.build_delivery_report(...)` in `mastering.py`: replace XTTS-specific wording with selected-engine-neutral wording.
- `EvaluationService._artifact_score(...)` in `evaluation.py`: stop using `wave` only; support FLAC/WAV via soundfile or ffprobe-backed quality metrics.
- `ASRBackcheckService.evaluate(...)` in `asr_backcheck.py`: include `trust_level: measured|fallback|unavailable` and avoid release-grade claims for heuristic WER.
- `SpeakerVerificationService.verify(...)` in `speaker_verification.py`: include `is_measured` and `trust_level`; fallback should be diagnostic only.

Removed functions:

- No function should be removed in the first implementation pass. Deprecated behavior should be migrated behind compatibility wrappers and tests.

[Classes]
Add quality-analysis service classes and modify existing service classes to consume measured quality reports.

New classes:

- `AudioQualityService` in `vclone/apps/api/app/services/audio_quality.py`: no inheritance; key methods `inspect`, `compare`, `recommend_actions`, and private helpers for FFmpeg/soundfile/wave inspection.
- `AudioEnhancementService` in `vclone/apps/api/app/services/audio_enhancement.py`: no inheritance; key methods `build_candidates`, `select_best`, `_run_ffmpeg_profile`.
- `SegmentQualityService` in `vclone/apps/api/app/services/segment_quality.py`: no inheritance; depends on `AudioQualityService`, `AutoTranscriptionService`, and `SpeakerVerificationService` where available.
- `DeepQualityService` in `vclone/apps/api/app/services/deep_quality.py`: no inheritance; depends on DB session plus existing services; updates `VoiceProfile` reports.
- `SynthesisQualityService` in `vclone/apps/api/app/services/synthesis_quality.py`: no inheritance; wraps ASR, prompt leak, speaker verification, and artifact scoring.
- Dataclasses listed in `[Types]`: `AudioQualityIssue`, `AudioQualityReport`, `AudioEnhancementCandidate`, `SegmentQualityReport`, `DeepQualityReport`, and `SynthesisChunkQualityResult`.

Modified classes:

- `Settings` in `vclone/apps/api/app/core/config.py`: add quality/enhancement thresholds and default them conservatively.
- `ProcessedAudioInfo` in `audio_processing.py`: add `source_quality_report`, `processed_quality_report`, `enhancement_profile`, and `quality_issues` fields or include them in an adjacent report object.
- `SegmentCurationResult` in `audio_segmenter.py`: add actual extracted seconds, detected-bound usage count, SRT fallback count, and quality summary.
- `DatasetRecord` in `voice_dataset.py`: add quality fields from `SegmentQualityReport` without breaking existing JSONL readers.
- `EnrollmentQualityReport` in `quality_scoring.py`: include `source_quality_score`, `conditioning_quality_score`, and measured/fallback trust markers.
- `CandidateGateResult` in `candidate_gating.py`: add `asr_trust_level`, `speaker_trust_level`, and `artifact_score`.
- `EvaluationReport` in `evaluation.py`: add `artifact_provider`, `measured_audio_quality`, and release-grade trust markers.
- `SynthesisRequest` in `schemas/synthesis.py`: align `require_native_master` with config/README and add optional `quality_policy` only if needed.

Removed classes:

- No classes should be removed in this pass.

[Dependencies]
Use only local/open-source dependencies, with heavyweight quality tools optional and graceful fallbacks when absent.

Dependency modifications:

- Add `pytest>=8` and optionally `pytest-cov>=5` under `[project.optional-dependencies].dev` so API tests can run reproducibly.
- Keep `ffmpeg` and `ffprobe` as required system tools documented in README; system capabilities should report them.
- Add optional `[project.optional-dependencies].quality` with packages such as `soundfile>=0.12.1`, `numpy>=1.26`, `scipy>=1.11`, and `noisereduce>=3.0` if compatible with the Python version. All code must still work without them by using FFmpeg/wave fallbacks.
- Consider optional `[project.optional-dependencies].vad` with a local VAD package only after checking compatibility; do not make VAD mandatory for baseline enrollment.
- Do not add cloud APIs or premium services. Future local open-source engine adapters such as F5-TTS/CosyVoice can be planned behind optional extras, but this implementation should first stabilize VoxCPM2/Chatterbox quality and diagnostics.
- Avoid moving model packages into frontend dependencies. Keep model/runtime dependencies inside API optional extras.

[Testing]
Add deterministic unit/integration coverage for quality scoring, curation bounds, mastering correctness, synthesis gates, and frontend type/build health.

Test requirements and validation strategy:

- API environment: `cd /Users/ramakanth/pers/self-voice-clone/vclone/apps/api && python3 -m pip install -e '.[dev]'` before running tests.
- API tests: `cd /Users/ramakanth/pers/self-voice-clone/vclone/apps/api && PYTHONPATH=. python3 -m pytest -q`.
- Frontend build: `cd /Users/ramakanth/pers/self-voice-clone/vclone/apps/web && npm run build`.
- Use generated tiny WAV fixtures in tests; do not require VoxCPM2/Chatterbox/XTTS model downloads for unit tests.
- Mock `AutoTranscriptionService`, `SpeakerVerificationService`, and engine calls in synthesis-quality tests.
- Add regression tests for:
  - negative LUFS/true-peak parsing in `AudioMasteringService._parse_float`;
  - FLAC artifact evaluation not falling back to constant `0.55`;
  - SRT extraction uses detected speech bounds and reports actual duration;
  - source audio with all-zero or very low-volume content is blocked or marked not ready;
  - enhancement candidates are rejected when they remove too much speech;
  - fallback ASR/SV reports are marked untrusted;
  - long-form synthesis still smoke-tests the locked candidate;
  - download media type matches generated format;
  - frontend pages compile after adding quality diagnostics.
- Manual validation with existing local assets:
  - `vclone/training-data/TG-2/TG.wav` should produce a usable curated prompt bank.
  - `vclone/training-data/long/Swami-long.wav` appears effectively silent in first-minute volume probing and should be flagged clearly as weak/unusable unless later non-silent ranges are found.
  - Existing generated files under `vclone/*.wav` should be evaluated as outputs, not used as source-quality ground truth.

[Implementation Order]
Implement the changes in dependency-safe layers: hygiene first, then measured quality, then curation/enhancement, then synthesis gates, then UI/docs.

1. Add dev/test dependency extras and update `.gitignore` for generated local artifacts without deleting user files.
2. Fix low-risk correctness bugs first: negative loudness parsing in `mastering.py`, FLAC/WAV media type in synthesis download, and stale UI copy that contradicts current behavior.
3. Add `AudioQualityService` and tests for decode, silence, clipping, loudness, and weak-input recommendations.
4. Integrate `AudioQualityService` into `AudioProcessingService` and `QualityScoringService`, preserving raw uploads and surfacing actionable blockers.
5. Modify `AudioSegmenterService` to extract detected speech bounds, compute actual selected durations, and test SRT overlap/offset cases.
6. Add conservative `AudioEnhancementService`, generate local enhancement candidates only when source metrics justify it, and reject over-processed derivatives.
7. Add `SegmentQualityService` and update `VoiceDatasetBuilder` prompt ranking, prompt readiness, and JSONL/manifest metadata.
8. Implement `DeepQualityService` and wire `VoiceProfileService.start_deep_quality_check` to produce real reports.
9. Add `SynthesisQualityService` and integrate consistent candidate/chunk gates into `SynthesisService`, including long-form locked-candidate smoke testing.
10. Update engine wrappers to validate generated artifacts and report output stats/generation parameters.
11. Replace heuristic-only evaluation paths with measured/trusted/fallback reporting in ASR, speaker verification, and evaluation reports.
12. Update frontend API types and pages to display source quality, prompt readiness, deep quality status, candidate decisions, and measured-vs-heuristic warnings.
13. Update README/design docs with local-only setup, quality limitations, and weak-input guidance.
14. Run API tests and frontend build; document any optional model tests that require installed local model dependencies.