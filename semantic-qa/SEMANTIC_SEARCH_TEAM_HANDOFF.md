# Semantic Search team handoff

## Objective

Ship a reproducible semantic-search release in which standard retrieval is calibrated, all displayed evidence is attributable to Swami, Deep Search completes within bounded time, and every quality claim comes from a saved benchmark artifact.

The current checkpoint is usable for standard semantic search. Deep Search remains blocked by the local Qwen adjudication timeout described in `benchmark/DEEP_SEARCH_QUALITY_RUN_REPORT.md`.

## Working rules for every owner

1. Start from a named stabilization branch and record the starting commit SHA. Do not mix distance-search experiments, generated benchmark corpora, or unrelated tool changes into these PRs.
2. Preserve `benchmark/deep_search_benchmark_queries.json`. Do not edit expected answers after seeing model output. Any legitimate correction needs a separate review record explaining the source evidence.
3. Save raw JSON from every live benchmark. A Markdown summary alone is not evidence.
4. Record the corpus database, retrieval schema, embedding model and digest, model tag, model digest, hardware allocation, command, start time, finish time, and commit SHA.
5. A test that only mirrors the implementation does not count. Tests must reproduce a known failure or protect a release invariant.
6. Do not claim that 50 cases ran when `eval:deep:validate` only validated the benchmark file.

## Current verified baseline

- Runtime: Node 22.
- Index: `universal_qa_v2`, `answer-unit-v7`, BGE-M3 1,024 dimensions.
- Standard relevance benchmark: 23/23, Recall@5 1.0, top-one 1.0, MRR 1.0, false-accept rate 0 across nine negatives.
- Exact structured-Q&A replay: 100/100 Recall@1 and Recall@5, zero wrong strong matches.
- Full suite checkpoint: 221 tests, 212 passed, 0 failed, 9 skipped.
- Production build passes.
- Service is configured on `http://127.0.0.1:8790`.

## Work package 1 — Deep Search runtime and cancellation

**Owner profile:** backend/runtime engineer  
**Files:** `src/ollama.js`, `src/deepSummaryManager.js`, `test/ollama.test.js`, `test/deepSummaryManager.test.js`

Tasks:

1. Verify the new hard wall-clock request timer closes a local HTTP connection that remains open without returning a body.
2. Confirm an aborted job closes the Ollama request, marks the active phase failed or cancelled, and releases the single-generation slot.
3. Remove multiplicative retries. There must be at most two adjudication attempts total, not model-call retries multiplied by HTTP retries.
4. Add a global Deep Search queue or return HTTP 409 while another Deep job is using Ollama. Per-job parallelism of one does not prevent multiple jobs from competing.
5. Expose queue time, model-load time, prompt-evaluation time, generation time, prompt tokens, completion tokens, and termination reason in the saved job metrics.
6. Test cancellation during planning and adjudication, hard call timeout, job timeout, and process restart.

Acceptance criteria:

- A deliberately hanging local server is terminated within requested timeout + 1 second.
- Cancelling a job makes its Ollama connection disappear within 5 seconds.
- A timed-out call cannot remain active after the job becomes terminal.
- A second Deep job is queued or rejected predictably; it never starts a competing generation.
- Unit and HTTP integration tests pass on Windows with Node 22.

## Work package 2 — Deep candidate reading and adjudication quality

**Owner profile:** retrieval/LLM engineer  
**Files:** `src/deepSummaryManager.js`, `src/ollama.js`, `test/deepSummaryManager.test.js`

Tasks:

1. Re-run `seed-datta-swami` on an awake machine after Work package 1. Use fast mode and save JSON.
2. Inspect the exact three selected units and their paragraph excerpts before changing prompts or limits.
3. Ensure a top-three original-query answer cannot be displaced by probe fusion or document length.
4. Preserve exact source offsets for bounded paragraph excerpts. Never cut a sentence or present a truncated story as complete.
5. Require `direct_answer` when evidence actually answers the user’s semantic question; source-title wording need not be identical.
6. Keep model output bounded: one decision per candidate, cluster label at most six words, relationship at most thirty words.
7. Reject personal experiences unless the user explicitly asks for examples, and reject every unit failing the authorship guard.

Seed acceptance criteria:

- Command exits 0 and writes `benchmark/results/deep_seed_<commit>.json`.
- Actual status is `direct`.
- Evidence contains `discourse:738:teaching:1`.
- Evidence recall and precision are both 1.0 for the reviewed seed case.
- Exact-evidence rate is 1.0.
- No evidence from `discourse:4291` is returned.
- Fast-mode wall time is under 15 minutes on the recorded hardware; no individual call exceeds 10 minutes.

Run command:

```powershell
$env:SEMANTIC_QA_EVAL_API='http://127.0.0.1:8790/api'
$env:SEMANTIC_QA_EVAL_PG_DATABASE='universal_qa_v2'
$env:SEMANTIC_QA_DEEP_REPORT='benchmark/results/deep_seed_<commit>.json'
fnm exec --using 22 npm.cmd run eval:deep -- --case=seed-datta-swami --deliberation=fast --max-records=20
```

## Work package 3 — Authorship and index provenance

**Owner profile:** data/indexing engineer  
**Files:** `src/corpusStructure.js`, import/rebuild scripts, database validation scripts

Tasks:

1. Audit every citable answer unit whose source text begins with an explicit `[By ...]` line.
2. Confirm a non-Swami byline without a later recognized `Swami replied:` boundary produces zero citable units.
3. Confirm a mixed document can retain only the explicit Swami reply span while excluding the devotee introduction.
4. Produce a read-only audit report listing source ID, detected byline, parser decision, and resulting answer-unit IDs.
5. Parameterize rebuild destination and build a candidate database such as `universal_qa_v3_candidate`. Do not overwrite `universal_qa_v2` during development.
6. Compare candidate counts, excluded documents, offset integrity, source hashes, and retrieval metrics before promotion.

Acceptance criteria:

- Zero citable units begin with an explicit non-Swami byline.
- Zero evidence rows have invalid source offsets or content hashes.
- Mixed-author tests retain only recognized Swami spans.
- The candidate index passes all standard benchmarks and the Deep seed gate before promotion is proposed.
- Promotion and rollback commands are documented and tested against disposable databases.

## Work package 4 — Held-out confidence and abstention benchmark

**Owner profile:** search-quality engineer plus human reviewer  
**Files:** new frozen benchmark under `benchmark/frozen/`, evaluation script, report generator

Build at least 150 reviewed queries:

- 50 positive paraphrases of existing teachings.
- 25 lexical traps where query terms occur in separate or contrasting clauses.
- 25 physical tasks, measurements, recipes, medical claims, and product questions absent from the corpus.
- 20 current-events or general-knowledge questions.
- 15 in-domain but unanswered spiritual questions.
- 15 noisy, misspelled, or transliterated questions.

Split them before tuning: 60% train, 20% tune, and 20% sealed test. The implementer must not inspect the sealed set until the change is frozen.

Do not grow `CRITICAL_ACTION_VERBS` one failure at a time. Replace hand-maintained exceptions with a documented intent/support representation, or prove through the sealed set that the simpler rule generalizes.

Acceptance criteria on the sealed set:

- Positive Recall@5 at least 0.95.
- Positive top-one accuracy at least 0.90.
- False-accept rate at most 0.02.
- No accepted answer whose required action, measurement, entity, or relation appears only across separate or contrasting clauses.
- Existing 23-case and 100-question gates remain unchanged.

## Work package 5 — Execute the complete Deep benchmark

**Owner profile:** evaluation owner independent from Work package 2  
**Prerequisites:** Work packages 1–3 complete and seed gate passed

Tasks:

1. Confirm the benchmark contract without changing it:

```powershell
fnm exec --using 22 npm.cmd run eval:deep:validate
```

2. Run all 50 reviewed cases on a dedicated, awake host. Disable sleep and do not run distance evaluations or another Ollama workload concurrently.
3. Save the raw JSON report under `benchmark/results/` with commit and model digest in the filename.
4. Independently inspect every failure. Classify it as retrieval miss, reading-budget miss, adjudication error, status error, provenance error, timeout, or benchmark error.
5. Fix code against train/tune evidence, then run the full frozen set once for the release candidate.

Release gates:

- `executedCases: 50` and `completeBenchmarkRun: true`.
- Exact-evidence rate 1.0.
- Forbidden-evidence rate 0.
- Candidate recall at least 0.95.
- Evidence recall and precision each at least 0.90.
- Answer-status accuracy at least 0.90.
- At least 7/8 unanswerable cases correctly abstain.
- No non-Swami evidence.
- No timeout or orphaned active request.
- Report includes p50/p95 latency and token totals.

## Work package 6 — Evaluation truth and documentation

**Owner profile:** QA/release engineer  
**Files:** benchmark reports, README, architecture, CI configuration

Tasks:

1. Generate every Markdown benchmark report from raw JSON.
2. Label validation, single-case execution, partial execution, and complete execution distinctly.
3. Add commit SHA, dirty-worktree status, corpus contract, model tag/digest, and hardware to the report header.
4. Make the evaluator exit nonzero for an incomplete benchmark and release-gate failures.
5. Add CI gates for unit tests, build, benchmark-schema validation, and report-schema validation. Keep live Ollama/PostgreSQL runs in a dedicated environment.
6. Update README and architecture only after measured behavior changes.

Acceptance criteria:

- No report can say “50-case run” unless the raw artifact contains 50 executed results.
- A one-case report visibly says `1/50 executed`.
- Markdown numbers are generated and match JSON exactly.
- The old 9.3 claim remains removed until all release gates pass.

## Integration order

Merge in this order:

1. Runtime deadlines, cancellation, and global queue.
2. Candidate reading and seed adjudication.
3. Authorship audit and candidate-index rebuild.
4. Held-out standard-search benchmark.
5. Full Deep benchmark execution and fixes.
6. Generated reports, documentation, and release decision.

Each PR must include the reproduced problem, minimal implementation diff, tests that fail before and pass after, commands and raw outputs, effect on the 23-case and 100-question gates, and artifact identifiers.

## Commands required before final review

```powershell
fnm exec --using 22 node --test
fnm exec --using 22 npm.cmd run build
$env:SEMANTIC_QA_EVAL_PG_DATABASE='universal_qa_v2'
fnm exec --using 22 npm.cmd run eval:universal
$env:SEMANTIC_QA_EVAL_CASE_LIMIT='100'
fnm exec --using 22 npm.cmd run eval:corpus
fnm exec --using 22 npm.cmd run eval:deep:validate
```

After the seed passes, run the full Deep command from Work package 5 and attach the raw JSON. Bring the PRs, raw artifacts, and failure ledger back for final review.
