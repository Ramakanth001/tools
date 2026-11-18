# Semantic search fixes and validation

Validated on Windows with Node.js 22.23.5, 12 November 2026.

## Corrections

| Issue | Implemented correction |
| --- | --- |
| Threshold-aware ordering happened after truncation | Pass the effective threshold through the passage ranker and order eligible results before applying record and visible result limits. |
| A title or associated-question string could certify an unrelated answer | Persist discovery kinds, leave document titles unpaired, and grant exact priority only to typed paired-question discovery with the same answer-unit ID as the retrieved passage. |
| Deep Search capped candidates by unguarded discovery similarity | Apply the shared guarded passage scores before the database result cap. Globally order passages so weak siblings cannot displace stronger sources. |
| Deep HNSW SET LOCAL settings ran outside a transaction | Execute retrieval and discovery fusion inside BEGIN/COMMIT; roll back errors. |
| An invalid highest-ranked passage suppressed a valid sibling | Validate author, context, story completeness and exact source offsets before evidence selection and source deduplication. Validate expanded context before selection. |
| Standard search could report an accepted answer when evidence selection abstained | Clear strongMatch and acceptedMatch when standard selection returns not_available. |
| Empty-result coverage was guessed and discovery was excluded | Obtain independent SQL candidate statistics even with zero eligible rows; count the distinct union of dense, lexical and discovered answer passages. Carry these counts into the Deep Search audit. |
| Indic tokenization split combining marks from words | Preserve Unicode marks within lexical tokens; cover Telugu and Malayalam in regression tests. |
| Changed indexing behavior reused the old contract | Advance to answer-unit-v7. Incremental sync rejects v6 and requires a full rebuild; GPT readers and setup accept v7 while retaining older read compatibility. |
| Windows test commands depended on shell wildcard or directory expansion | Use node --test discovery for both packages. |
| The default Node 20 runtime was too old for Vite | Declare Node >=22.12.0, pin the validated release in .node-version and execute verification under Node 22.23.5. |

Existing contextual embedding, paragraph merging, lexical expansion and hybrid-scoring changes are retained. Existing user edits have not been reverted.

## Executed checks

- Semantic QA full suite with live PostgreSQL/pgvector/Ollama integration enabled: **176 passed, 0 failed, 0 skipped**.
- GPT full suite: **86 passed, 0 failed**.
- Both production builds completed successfully under Node 22.
- git diff --check passed.
- New HTTP regression test exercises the production search route, including topK=1 and rejected-evidence status.
- New embedded PostgreSQL/pgvector test executes production schema creation, staging inserts, atomic rebuild promotion, HNSW index creation and retrieval SQL. It verifies typed pairing, guarded ranking, actual transaction-local HNSW settings and restoration, empty-result statistics, and rollback after a dimension error. This uses an in-memory PostgreSQL engine; it does not validate the installed external PostgreSQL server.

Run from this workspace with fnm:

```powershell
fnm exec --using 22 npm.cmd --prefix semantic-qa test
fnm exec --using 22 npm.cmd --prefix gpt test
fnm exec --using 22 npm.cmd --prefix semantic-qa run build
fnm exec --using 22 npm.cmd --prefix gpt run build
```

## Current live validation and remaining deployment issue

Rechecked after the database service was restored on 12 November 2026. PostgreSQL at 127.0.0.1:5433 and Ollama are reachable. Both configured source and index roles authenticate successfully. The external server has vector 0.8.7 and pg_trgm 1.6. The previously skipped live connectivity test now passes.

The full source preflight passes for 6,010 documents. The current parser produces 11,355 answer units, 39,601 answer passages, and 28,317 discovery passages. The 105 documents producing no answer units all have only explicit other-speaker markers; they are intentionally excluded from citable Swami evidence, not confirmed parser failures.

The active index still reports **answer-unit-v5** and **embeddinggemma-asymmetric-v3**, with 6,010 records, 11,337 answer units, 73,587 passages, and 21,302 discovery passages. Current code requires answer-unit-v7 and embeddinggemma-asymmetric-v4. Requests through the real route handlers for ordinary semantic search (summary off), Verbatim Selection, and Deep Search all return **HTTP 409**, listing these two obsolete contracts and requiring a full rebuild. The fixed ranking and typed discovery behavior therefore has not been activated on this corpus. Existing HNSW indexes also retain default options, which the rebuild replaces with the current settings.

Read-only integrity checks found zero orphan passages, zero passages missing their answer unit, zero passage-text offset mismatches, and zero citation-text offset mismatches across all 73,587 passages. All indexed documents have matching source text; no indexed source IDs are missing from the source projection. All active answer units have author Swami. The older index has 121 documents without answer units, compared with the current parser's 105 intentional exclusions.

No active corpus was rebuilt or promoted during this validation. The remaining action is a full v7 rebuild, followed by retrieval and promotion evaluations against the rebuilt index. Corpus relevance metrics cannot be measured through the current API while its compatibility guard correctly rejects the old index. The UI full rebuild uses its saved connections. The legacy `rebuild:universal:v5` script builds the current contract but uses the preset in `scripts/universalV5Config.js`; check that target before running it. Incremental sync intentionally cannot upgrade an older index.

Deep Search remains bounded candidate retrieval. Its scannedPassages count means distinct answer passages collected by retrieval, not internal ANN nodes visited or passages fully adjudicated by a model. Full-corpus relevance, cross-language recall, threshold calibration and model latency require live evaluation data.
