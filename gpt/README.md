# GPT

GPT is a private, local conversational researcher for the existing spiritual corpus. It queries the PostgreSQL/pgvector index directly, uses EmbeddingGemma for retrieval, and uses Qwen3 14B through Ollama for planning, evidence adjudication, synthesis, and claim verification.

It does **not** call Search Engine, Standard Summary, Deep Summary, or any cloud service. Its only shared resources are the indexed PostgreSQL corpus and the local Ollama process.

## Architecture

- `src/corpus.js` is a read-only adapter for `semantic_qa.corpus`, `semantic_qa.records`, and `semantic_qa.passages` with an explicit `passage-v4` contract.
- `src/research.js` implements mandatory retrieval, bounded follow-up queries, relationship-aware evidence adjudication, context expansion, drafting, verification, repair, and corpus-only abstention.
- `src/store.js` persists conversations, messages, turn traces, evidence snapshots, settings, and benchmark results in the separate `spiritual_gpt` database.
- `src/registerRoutes.js` exposes only the GPT API and streams status plus the verified final result as NDJSON.
- `src/sharedTypes.d.ts` defines the API contracts shared by the server and interface.
- `src/ui/GptTool.jsx` provides the chat, source drawer, persistent conversation list, cancellation, regeneration, and setup UI.

Raw chain-of-thought is never displayed or stored. Unverified draft text is not streamed to the browser.

## Local setup

1. Create the separate roles and chat database:

   ```bash
   /opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -p 5433 -U "$(whoami)" -d postgres -f ./gpt/setup/postgres.sql
   ```

   The script deliberately does not place passwords in source control. If your local PostgreSQL does not use trusted local authentication, set passwords for `spiritual_gpt_index_reader` and `spiritual_gpt_app` interactively with `psql`’s `\password` command, then enter them in Setup.

2. Install both candidate quantizations and EmbeddingGemma:

   ```bash
   ollama pull embeddinggemma
   ollama pull qwen3:14b-q4_K_M
   ollama pull qwen3:14b-q8_0
   ```

3. Start the standalone tool:

   ```bash
   npm run dev:gpt
   ```

   Open `http://localhost:5178`. The API and production UI run on `http://localhost:8793` after `npm run build:gpt && npm run start:gpt`.

4. Open **Setup**, verify the read-only index and conversation database connections, and explicitly select a Qwen tag. There is deliberately no implicit Q4/Q8 default.

The Setup screen now provides the same guided onboarding style as Search Engine. It can create the two fixed GPT roles and `spiritual_gpt` database through a local administrator connection, install all three allowlisted Ollama models with live download progress, select Q4 or Q8, and run the final compatibility diagnostics. The administrator and role passwords remain in memory only.

The shared workspace exposes the same tool at `http://localhost:5173/tools/gpt`.

### Memory behavior

The default context budget is 8,192 tokens, which is sufficient for the bounded evidence packets used by the pipeline and is substantially lighter than the earlier 24,576-token reservation. Setup also offers 12K and 16K budgets for unusually large comparisons. The default memory-safe policy unloads Qwen after each completed or cancelled turn; within a turn the model remains warm across planning, adjudication, drafting, and verification calls.

The chat composer exposes both the context budget and a four-level answer-temperature control. Temperature 0.1 stays close to corpus terminology, 0.3 is the balanced default, 0.5 uses more natural paraphrasing, and 0.7 provides the most interpretive cross-source synthesis. This temperature applies only to answer drafting. Planning, retrieval, evidence adjudication, citation rendering, and final support verification keep their accuracy-oriented settings.

For direct standalone questions, GPT searches the exact question first and avoids a separate planning generation. Broad advice questions review up to 48 candidates and synthesize a source-diverse set of up to twelve answer-bearing passages into three or four independently verified paragraphs. Complex comparisons and conversational follow-ups still use model-based planning. If verification rejects only part of an answer, unsupported paragraphs are removed while independently supported paragraphs are retained.

Every assistant answer has an **Export** menu for PDF, Word-compatible DOC, standalone HTML, and plain TXT. PDF opens a print-ready document where the local browser can save directly as PDF. Every format contains the verified answer and only the exact cited excerpt snapshots, with citation number, title, source ID, passage index, character span, and available locator metadata. Exports never include the complete discourse or the larger source-context metadata.

### Interrupted Ollama downloads

Docker is not required. Ollama uses an OCI-compatible model registry, so download URLs can contain `/docker/registry/` even when Docker is not installed or used.

The Setup screen retries transient network failures up to three times. If an error mentions `utun`, `socket is not connected`, or Cloudflare R2, a VPN/tunnel route has usually interrupted the large download. Disconnect or stabilize that tunnel (or switch networks), then press **Retry**. Ollama can reuse data already downloaded for the model.

## Environment configuration

The UI keeps database passwords and connection strings in process memory only. A service installation can instead provide:

- `GPT_INDEX_URL`
- `GPT_CHAT_DATABASE_URL`
- `GPT_OLLAMA_URL`
- `GPT_EMBEDDING_MODEL`
- `GPT_CHAT_MODEL`

As with the other tools, a non-loopback HTTP listener requires `TOOLS_AUTH_TOKEN`.

## API

- `GET /api/setup/status`
- `POST /api/setup/database`
- `POST /api/setup/models/pull` (NDJSON progress; allowlisted local models only)
- `GET /api/health`
- `GET|PUT /api/settings`
- `GET|POST /api/conversations`
- `PATCH|DELETE /api/conversations/:id`
- `GET|POST /api/conversations/:id/messages`
- `POST /api/turns/:id/cancel`
- `POST /api/turns/:id/regenerate`
- `GET /api/sources/:sourceId?passageIndex=N`
- `GET|POST /api/benchmarks`

The message and regenerate endpoints return `application/x-ndjson` events: `status`, `answer`, `sources`, `done`, and `error`.

## Accuracy behavior

- Every substantive corpus question performs at least one retrieval pass.
- Dense passage, full-text, exact phrase, trigram, and title-discovery channels are fused before model adjudication.
- Title matches only discover sources; answer passages must independently support the claim.
- The model can request no more than two focused follow-up searches.
- Every generated claim is checked against cited evidence. One repair pass is allowed; unresolved answers abstain.
- Citation numbers and source locators are rendered by the server, not invented by the model.
- Old conversations retain exact evidence snapshots even if the live corpus later changes.

## Tests and evaluation

```bash
npm run test:gpt
npm run build:gpt
```

The quantization evaluator reads `eval/cases.json`, exercises the complete HTTP pipeline with three seeds, records results in the conversation database, measures end-to-end/retrieval latency plus peak memory pressure and swap growth, and applies the Q4/Q8 selection policy. It selects the passing recommendation for subsequent turns; if neither model passes, it leaves accuracy-first mode without a default:

```bash
GPT_BENCHMARK_API=http://127.0.0.1:8793/api npm run benchmark:gpt
```

The checked-in cases are a starter set derived from known corpus retrieval cases. Production selection intentionally refuses to run until the suite contains at least 150 human-reviewed turns, unless `GPT_BENCHMARK_ALLOW_PARTIAL=1` is explicitly set for development.
