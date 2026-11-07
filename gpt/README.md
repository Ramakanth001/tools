# Local Corpus GPT

Local Corpus GPT is a private, ChatGPT-style research tool for the existing spiritual corpus. It performs fast hybrid retrieval directly against PostgreSQL, reads and evaluates the retrieved answers with Qwen3 14B, verifies the response against exact corpus spans, and provides supporting citations.

The UI name is **GPT**. It is a separate product from **Search Engine**, **Verbatim Selection**, and **Deep Search**.

## Design goals

- Give accurate, developed answers from the local corpus rather than generic pretrained opinions.
- Understand follow-up questions and preserve conversational context.
- Route corpus-wide recurring-topic requests through a complete-document clustering task instead of narrow retrieval.
- Search multiple ways when one semantic query is insufficient.
- Read complete source answers before selecting the relevant paragraphs.
- Distinguish direct support from merely related text.
- Handle comparisons, qualifications, and apparent contradictions.
- Preserve exact wording at temperature `0.1`.
- Attach citations to the claims they support without making citations the whole experience.
- Abstain when the corpus does not contain enough evidence.
- Run locally without paid APIs, cloud LLMs, web search, or Docker.

## Technology stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Language runtime | Node.js | Server, orchestration, model client, database access, and tooling |
| Backend | Express 5 | Standalone HTTP API, setup endpoints, static production UI, and NDJSON streams |
| Frontend | React 19 | Chat interface, settings, conversation history, citations, and source drawer |
| Frontend build | Vite 7 | Development server and production bundle |
| Validation | Zod 4 plus deterministic server checks | Runtime settings, structured model responses, tool arguments, and evidence identity |
| Corpus database | PostgreSQL with pgvector and `pg_trgm` | Dense vector, full-text, exact-phrase, fuzzy, title, and question discovery |
| Conversation database | PostgreSQL, database `spiritual_gpt`, schema `gpt` | Chats, turns, memory, evidence snapshots, settings, and benchmark results |
| Local model runtime | Ollama | Runs both the embedding model and Qwen locally |
| Embedding model | EmbeddingGemma | Embeds every retrieval probe and reranks stored source questions |
| Chat/research model | Qwen3 14B | Planning, semantic adjudication, answer selection, synthesis, and verification |
| Supported quantizations | `qwen3:14b-q4_K_M`, `qwen3:14b-q8_0` | User-selectable local accuracy/memory trade-off |
| Streaming protocol | NDJSON over HTTP | Sends research status immediately and the answer only after verification |
| Export | Browser print-ready HTML | Per-answer PDF, DOC, HTML, TXT, and complete-chat PDF |
| Tests | Node.js built-in test runner | Unit, integration, isolation, setup, export, retrieval, and route tests |

No OpenAI API, cloud model, external web search, or Docker runtime is used.

## Product isolation

GPT has its own package, server, routes, UI, prompts, Ollama adapter, research state machine, storage, setup flow, tests, and runtime configuration.

It does **not**:

- import or call Search Engine routes;
- call the existing six-phase Deep Search pipeline;
- call Verbatim Selection or Deep Search;
- initialize, synchronize, alter, or rebuild the corpus index;
- write to `semantic_qa.records`, `semantic_qa.passages`, or `semantic_qa.corpus`;
- use a cloud fallback when local retrieval or Ollama is unavailable.

The only shared infrastructure is the existing PostgreSQL corpus and the local Ollama service. An automated isolation test prevents dependencies on Search Engine and Deep Search code or endpoints.

## Runtime topology

| Surface | Address |
| --- | --- |
| Standalone development UI | `http://localhost:5178` |
| Standalone production UI and API | `http://localhost:8793` |
| Workspace route | `http://localhost:5173/tools/gpt` |
| Workspace API namespace | `/api/tools/gpt` |
| Standalone API namespace | `/api` |
| Default Ollama service | `http://127.0.0.1:11434` |
| Default PostgreSQL service | `127.0.0.1:5433` |

The standalone server binds to loopback only. A non-loopback host is rejected. The API also rejects non-loopback clients and retains the workspace's local-auth behavior.

## Databases and roles

### Read-only corpus index

Default database: `universal_qa_index`

Default role: `spiritual_gpt_index_reader`

The reader is limited to `CONNECT`, schema `USAGE`, and `SELECT` on:

- `semantic_qa.corpus`
- `semantic_qa.records`
- `semantic_qa.passages`
- `semantic_qa.answer_units`
- `semantic_qa.discovery_passages`
- `semantic_qa.source_aliases`

The corpus is treated as a versioned read-only contract. GPT requires `answer-unit-v5` and refuses research turns when required tables, privileges, or metadata are missing, the EmbeddingGemma format is unsupported, or the embedding contract is incompatible. It never imports Search Engine implementation code and never repairs or mutates the corpus.

### Conversation database

Database: `spiritual_gpt`

Schema: `gpt`

Default role: `spiritual_gpt_app`

The conversation database stores:

- conversations and editable titles;
- user and assistant messages;
- turn status, objective, probes, timing, and errors;
- rolling conversation memory;
- exact evidence snapshots, offsets, scores, channels, and adjudication;
- model tag, digest, options, and corpus fingerprint;
- non-secret runtime settings;
- benchmark runs and recommendations.

Stored assistant prose is never promoted into corpus evidence. Citations are reconstructed from saved evidence snapshots, so old conversations retain the evidence used at the time of the answer.

## Research workflow

### 1. Understand the turn

GPT builds a standalone research objective from the latest message, recent dialogue, and compact rolling memory. It identifies the intent, language, entities, facets, relationships, quotations, and retrieval probes. Follow-ups resolve references such as “that,” “compare it with…,” or “why did you say this?” without embedding the entire transcript.

Casual conversation may skip retrieval. Substantive spiritual claims require corpus evidence.

### 2. Mandatory initial retrieval

The server always searches before Qwen can answer a substantive question. A direct question starts with the user's exact wording. Advice, permission, comparison, and contradiction questions also receive focused probes for governing principles, qualifications, the other comparison side, relationships, or counterevidence.

All probes are embedded with EmbeddingGemma. PostgreSQL searches several channels while keeping citable answers separate from non-citable discovery context:

- pgvector dense passage similarity;
- passage full-text search;
- exact quoted-phrase matching;
- trigram word similarity for short fuzzy queries;
- title and devotee-question discovery through `discovery_passages`.

Results are fused with weighted reciprocal-rank fusion, deduplicated, capped per source group, and kept source-diverse. Vector retrieval uses `hnsw.ef_search = 200`. Every probe runs in a short read-only transaction.

A question/title match can discover a source, but it cannot support the answer by itself. An answer-bearing corpus span must be accepted separately.

### 3. Read source context

For each promising source, GPT reads complete `answer_units` directly. The role-aware index has already separated devotee questions from `swami_reply`/`swami_teaching` units and recorded their exact document offsets and hashes. GPT does not reconstruct speaker roles from old chunks.

Legacy citation IDs resolve through `source_aliases`, so prior chunk-based conversations can still open the canonical document or answer unit after the v5 promotion.

### 4. Semantic evidence adjudication

Qwen reviews the retrieved material semantically. It must distinguish:

- a direct answer;
- a governing spiritual principle;
- a qualification or condition;
- a requested example;
- support, opposition, context, or reconciliation;
- a merely topical or irrelevant passage.

The model selects server-created evidence or paragraph IDs. It does not author citation text or offsets. The server independently rejects question-only fragments, incomplete spans, duplicate quotations, and invalid source identities.

### 5. Bounded follow-up research

When the initial evidence has a genuine gap, the research loop can issue focused additional searches. Tool arguments, limits, filters, and result sizes are validated by the server. Failure of an optional search does not erase already accepted initial evidence.

The model receives no SQL credentials, arbitrary file access, unrestricted source reader, web search, or access to another product pipeline.

### 6. Draft the answer

At normal temperatures, Qwen synthesizes a structured answer across accepted sources. At temperature `0.1`, it selects exact corpus paragraphs by ID and the server inserts the original wording word for word.

Broader context settings admit more candidate passages and complete-answer material; they do not merely enlarge an otherwise empty model window.

### 7. Verify and repair

Every substantive generated paragraph or claim is checked against the referenced evidence. Citation IDs, exact spans, and excerpt identity are also validated deterministically.

Unsupported material is removed or narrowed in one repair pass. Supported paragraphs can survive even when another paragraph fails. If the core answer remains unsupported, GPT returns a transparent corpus-only abstention.

### 8. Render the verified result

The server renders citation markers from verified evidence IDs. Unverified draft tokens and chain-of-thought are never streamed, displayed, or persisted. The UI receives the verified answer, exact sources, research statistics, and completion event.

## Conversation memory

GPT maintains two different forms of context:

1. **Dialogue memory** - a compact structured state containing the topic, entities, unresolved questions, and user preferences, plus the latest six exchanges.
2. **Evidence memory** - recently cited source references that may help interpret a follow-up. They are revalidated for the new question and never replaced by previous assistant wording.

Conversation memory is updated during turn planning; there is no separate background summarization job. Topic changes are allowed, and the current question is never trimmed.

## Context and answer-style controls

| Context option | Intended use | Trade-off |
| --- | --- | --- |
| 8K | Normal questions and memory-safe operation | Lowest RAM use; default |
| 12K | Broader research and larger comparisons | More evidence and longer runtime |
| 16K | Maximum available local evidence budget | Highest RAM use and latency |

| Temperature | UI mode | Behavior |
| --- | --- | --- |
| `0.1` | Verbatim | Exact corpus paragraphs only; no paraphrasing |
| `0.3` | Balanced | Conservative synthesis; default |
| `0.5` | Natural | More fluent paraphrasing while remaining evidence-bound |
| `0.7` | Interpretive | Most expressive cross-source synthesis, still verified |

The allowed context and temperature values are validated on both client and server.

## Model and memory behavior

- No Qwen model is selected implicitly during initial setup.
- Both supported quantizations remain selectable in Settings.
- EmbeddingGemma is normally kept alive for five minutes.
- Qwen stays available across the calls within one research turn.
- The default keeps Qwen warm for five minutes so conversational follow-ups avoid a full 14B-model reload; users can still select immediate unloading to release RAM.
- An optional setting keeps Qwen warm for five minutes for faster subsequent turns.
- Only one Qwen generation is allowed globally at a time; retrieval probes do not require a second Qwen instance.
- Model changes apply to later turns and the previous model is explicitly unloaded.

## User interface

The React interface provides:

- persistent chat history with new, rename, and delete controls;
- a central Markdown transcript with lists, quotations, code, and tables;
- a fixed composer with context and temperature selectors;
- research stages such as understanding, searching, comparing, reading, extracting, drafting, and verifying;
- stop, copy, regenerate, and per-answer export controls;
- inline citations that open an exact-source drawer;
- full-source reconstruction with the cited answer span highlighted;
- a collapsed research-details panel without chain-of-thought;
- responsive chat and source drawers for smaller screens.

### Exports

Every assistant answer can be exported as:

- PDF through the browser's print/save dialog;
- Word-compatible DOC;
- standalone HTML;
- plain TXT.

An individual answer export uses the user question immediately preceding that answer, not the first question in the chat.

**Export chat PDF** creates one document containing every question and answer in the current conversation. Citations are placed directly beneath the answer they support. Exports contain only the exact cited excerpt snapshots and available source metadata; they never include the entire discourse or hidden source context.

## Local setup

### Prerequisites

- Node.js and npm
- PostgreSQL with pgvector and `pg_trgm`
- Ollama running locally
- Enough disk space for EmbeddingGemma and one or both Qwen quantizations

Docker is not required.

### 1. Create the roles and conversation database

From the workspace root:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql \
  -h 127.0.0.1 \
  -p 5433 \
  -U "$(whoami)" \
  -d postgres \
  -f ./gpt/setup/postgres.sql
```

The provisioning script does not place passwords in source control. If trusted local authentication is unavailable, set passwords interactively:

```text
\password spiritual_gpt_index_reader
\password spiritual_gpt_app
```

Enter those passwords in **Setup & models**. The guided Setup screen can also provision the two fixed roles and database from a loopback administrator connection.

### 2. Install the local models

```bash
ollama pull embeddinggemma
ollama pull qwen3:14b-q4_K_M
ollama pull qwen3:14b-q8_0
```

The guided Setup screen can install these allowlisted models with live progress. It cannot pull arbitrary tags.

### 3. Start development

From the workspace root:

```bash
npm run dev:gpt
```

Open `http://localhost:5178`.

### 4. Verify setup

Open **Setup & models** and confirm:

1. the read-only corpus connection is compatible;
2. the conversation database is initialized;
3. Ollama is reachable;
4. EmbeddingGemma is installed;
5. one Qwen quantization is explicitly selected and installed.

### Production build

```bash
npm run build:gpt
npm run start:gpt
```

Open `http://localhost:8793`.

## Environment configuration

The Setup UI keeps supplied database passwords and connection strings in process memory. Persisted settings have secrets removed. A service installation can use:

| Variable | Purpose |
| --- | --- |
| `GPT_INDEX_URL` | Read-only PostgreSQL corpus connection string |
| `GPT_CHAT_DATABASE_URL` | Conversation database connection string |
| `GPT_OLLAMA_URL` | Loopback Ollama base URL |
| `GPT_EMBEDDING_MODEL` | Embedding model tag; normally `embeddinggemma` |
| `GPT_CHAT_MODEL` | Explicit allowlisted Qwen tag |
| `HOST` | Standalone loopback listener; default `127.0.0.1` |
| `PORT` | Standalone port; default `8793` |
| `TOOLS_AUTH_TOKEN` | Workspace/local API authentication when required by the host application |

Signed download URLs and PostgreSQL passwords are redacted from surfaced errors.

## API

The paths below use `/api` in standalone mode and `/api/tools/gpt` inside the shared workspace.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/setup/status` | Database defaults, Ollama readiness, and installed allowlisted models |
| POST | `/setup/database` | Provision the fixed local roles, grants, database, and schema |
| POST | `/setup/models/pull` | Stream an allowlisted Ollama model installation |
| GET | `/health` | Corpus, chat database, Ollama, model, and setup readiness |
| GET / PUT | `/settings` | Read or update non-secret runtime preferences |
| GET / POST | `/conversations` | List or create chats |
| PATCH / DELETE | `/conversations/:id` | Rename or delete a chat |
| GET | `/conversations/:id/messages` | Load transcript, research details, and citations |
| POST | `/conversations/:id/messages` | Run a research turn and stream NDJSON events |
| POST | `/turns/:id/cancel` | Abort retrieval and local model work |
| POST | `/turns/:id/regenerate` | Regenerate the latest user turn |
| GET | `/sources/:sourceId` | Reconstruct the source and highlight the cited answer span |
| GET / POST | `/benchmarks` | Read or store local benchmark results |

Research streams use `application/x-ndjson` and emit typed `status`, `answer`, `sources`, `done`, and `error` events. Only a verified final answer is emitted as answer content.

## Important shared types

- `ResearchObjective` - standalone question, intent, language, entities, facets, probes, and rolling memory.
- `EvidenceRef` - stable source identity, passage and character offsets, exact excerpt snapshot, metadata, locator, retrieval channels, scores, stance, and support verdict.
- `VerifiedClaim` - claim text, evidence IDs, and supported/contradicted/insufficient verdict.
- `TurnEvent` - typed status and final-result stream events.

Definitions live in `src/sharedTypes.d.ts`.

## Project structure

```text
gpt/
├── setup/postgres.sql       Fixed local roles, grants, database, and schema
├── scripts/                 Quantization benchmark runner
├── eval/                    Human-reviewed benchmark cases
├── src/
│   ├── config.js            Allowlisted models and validated runtime settings
│   ├── corpus.js            Read-only hybrid corpus adapter and contract checks
│   ├── ollama.js            Local embeddings, chat, structured output, and unloads
│   ├── postgres.js          Configurable PostgreSQL connection pools
│   ├── registerRoutes.js    GPT-only HTTP API and NDJSON orchestration
│   ├── research.js          Retrieval, adjudication, drafting, and verification
│   ├── setup.js             Guided local provisioning
│   ├── store.js             Conversation and evidence persistence
│   ├── server.js            Loopback standalone server
│   ├── sharedTypes.d.ts     Shared API contracts
│   └── ui/                  React chat, settings, source viewer, CSS, and exports
└── test/                    Unit and integration tests
```

## Tests

From the workspace root:

```bash
npm run test:gpt
npm run build:gpt
```

The suite covers:

- read-only database enforcement and corpus compatibility;
- hybrid fusion, exact phrases, source grouping, and context expansion;
- complete-answer reconstruction and exact paragraph offsets;
- semantic rejection of topical but unsupported evidence;
- malformed Ollama JSON recovery;
- conversation memory and multilingual/follow-up behavior;
- claim verification, repair, citation rendering, and abstention;
- cancellation, regeneration, settings, model setup, and API streams;
- per-answer and complete-chat exports;
- isolation from Search Engine and Deep Search.

## Quantization benchmark

The benchmark exercises the complete HTTP pipeline, not raw token generation. It uses fixed seeds and records grounded correctness, citation support, unsupported claims, abstention, comparison/contradiction accuracy, latency, peak memory pressure, and swap growth.

```bash
GPT_BENCHMARK_API=http://127.0.0.1:8793/api npm run benchmark:gpt
```

The production selector requires at least 150 human-reviewed turns unless partial development evaluation is explicitly enabled:

```bash
GPT_BENCHMARK_ALLOW_PARTIAL=1 \
GPT_BENCHMARK_API=http://127.0.0.1:8793/api \
npm run benchmark:gpt
```

Q4 is recommended only when it passes every absolute accuracy gate, remains within the configured quality margin of Q8, does not materially increase unsupported claims, and improves latency or memory by at least 20%. Otherwise Q8 is preferred. If neither passes, no accuracy-first default is declared.

## Troubleshooting

### Ollama download mentions `docker/registry`

Docker is still not required. Ollama uses an OCI-compatible registry format, so download URLs can contain `/docker/registry/`.

### Download fails through Cloudflare R2, `utun`, or “socket is not connected”

A VPN or tunnel route commonly interrupted the large model download. Stabilize or disconnect the tunnel, or switch networks, then retry. Ollama normally reuses already downloaded layers. Guided Setup retries transient download failures up to three times.

### Setup says the corpus is incompatible

Check the active row in `semantic_qa.corpus`. GPT expects retrieval schema `answer-unit-v5`, a supported EmbeddingGemma asymmetric format, matching embedding dimensions and digest, and readable v5 tables. GPT deliberately will not modify the index to make it compatible.

### RAM usage is too high

- Select the 8K context budget.
- Keep **Unload Qwen and release RAM** enabled.
- Use Q4 if it satisfies the local accuracy benchmark.
- Avoid running another large Ollama product at the same time.
- Cancel a turn before changing model or memory settings.

### A corpus answer is unavailable

Confirm Ollama and both databases are healthy, then inspect **Research details** and the exact citations. A transparent abstention means the verifier did not find sufficient direct support; it does not trigger pretrained or cloud fallback text.

## Security and privacy

- All inference and embeddings remain local through Ollama.
- Corpus queries use a dedicated read-only PostgreSQL role.
- Conversation writes use a different database and role.
- Database credentials are never given to Qwen.
- The model cannot execute SQL or read arbitrary files.
- Raw chain-of-thought is never displayed or persisted.
- Unverified drafts are withheld from the browser.
- The standalone listener and Ollama URL are restricted to loopback hosts.
- There is no web-search or cloud fallback.

## Current scope

V1 does not fine-tune Qwen, duplicate the vector corpus, alter Search Engine behavior, add cloud services, or attempt to answer unsupported spiritual questions from model pretraining. Optional book, chapter, page, and section locators are supported when present in source metadata but are not required by the citation contract.
