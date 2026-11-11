# Search Engine

Search Engine (internally still identified as `semantic-qa` for route and settings compatibility) is a context-faithful semantic teaching search. MySQL remains the source of truth. A PostgreSQL source projection keeps one row per original document, and a separate pgvector database indexes role-aware Swami answer units plus exact logical passages. Titles and devotee questions can discover a source, but can never be cited as Swami's teaching.

Every displayed teaching is inserted by deterministic server code from an exact stored `display_text.slice(start, end)`. Models may plan queries, judge relevance, classify, and group teachings. They may not compose, correct, translate, or rewrite Swami's words.

The tool includes a 20-record sample corpus and local-demo preset. It still requires running PostgreSQL and Ollama services. The **Setup** screen checks each dependency and shows what is missing.

For a newcomer-oriented explanation of Ollama, EmbeddingGemma, model training versus indexing, pgvector, HNSW, cosine similarity, synchronization, multilingual handling, and the complete request flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).

> ⚡ **Distance-Based Search Documentation:**  
> For complete architectural documentation, mathematical formulations, ranking rulesets, IAST diacritic folding, sentence-boundary snippeting, rolling token proximity, and the deep-linking reader engine, see **[DISTANCE_SEARCH_README.md](./DISTANCE_SEARCH_README.md)**.

## What Is Implemented

- PostgreSQL connection testing and source catalog discovery
- Selectable ID, question, answer, metadata, group, and source-order columns
- Local Ollama embeddings through `POST /api/embed`
- pgvector storage with an HNSW cosine index
- One-row-per-document source projection with immutable `raw_content`, faithful `display_text`, and SHA-256 hashes
- English, Malayalam, and Telugu parsing of explicit devotee-question and Swami-reply boundaries
- Citable `swami_reply` and `swami_teaching` units; separate non-citable title/question discovery passages
- Complete paragraph, stanza, and list-item citation spans with bounded overlapping retrieval windows
- Passage-level semantic retrieval across Swami answer text, with lexical, exact-phrase, and fuzzy discovery channels
- Conventional Search that fuses exact phrases, PostgreSQL full-text rank, and trigram word-distance rank with reciprocal-rank fusion
- Zero question/title weight in passage acceptance, plus document-group deduplication
- Exact quoted-phrase identity checks, so nearby statements with reversed relationships do not outrank the requested quotation
- Atomic full rebuilds and content-hash-based incremental synchronization
- Deletion reconciliation after a successful source scan
- Verbatim stored teachings with source IDs, answer-unit IDs, roles, kinds, hashes, and document offsets
- Fast Verbatim Selection mode with no text-generation call
- Six-stage Deep Search with multi-query retrieval, complete-answer reading, two independent Qwen adjudications, disagreement resolution, teaching clustering, and final exact-span verification
- Honest `direct`, `related_teachings`, and `insufficient` outcomes
- Dedicated reasoning-capable Qwen model enforcement with no silent Gemma fallback
- A searchable catalog of all synchronized discourses
- Clickable source citations that reconstruct the full ordered discourse and highlight the cited answer passage
- Deep Search export to Markdown and browser Print / Save PDF
- Configurable result count and clear-match threshold
- Standalone and shared-workspace operation

Verbatim Selection returns exact accepted source spans. Deep Search can discard evidence at every stage and abstains when no responsibly relevant Swami teaching survives. Personal experiences and success anecdotes are excluded unless the question explicitly asks for examples. A story is citable only when its consequence and Swami's stated lesson are present.

## Prerequisites

### 1. Node.js

Use the Node.js version used by the parent tools workspace, then install dependencies:

```bash
npm install
npm --prefix ./pg-backup install
npm --prefix ./mysql-pg-migrate install
npm --prefix ./semantic-qa install
```

The fallback dependency resolution lets the tool use compatible workspace packages, but installing `semantic-qa` directly is recommended.

### 2. Ollama and an embedding model

On macOS with Homebrew:

```bash
brew install ollama
brew services start ollama
ollama pull embeddinggemma
```

Alternatively, run `ollama serve` in a dedicated terminal.

Verify the service:

```bash
curl http://127.0.0.1:11434/api/embed \
  -d '{"model":"embeddinggemma","input":"connectivity test","truncate":false}'
```

The tool defaults to:

```text
Ollama URL: http://127.0.0.1:11434
Model:      embeddinggemma
```

Ollama must be reachable from the Node.js backend. Remote Ollama URLs are intentionally rejected; v1 accepts loopback hosts only.

### 3. Source PostgreSQL database

The source account needs `CONNECT`, `USAGE` on the selected schema, and `SELECT` on the Q&A table. It must not need write privileges.

The source table needs:

- one non-null unique ID column;
- one non-empty question column;
- one non-empty answer column;
- optional metadata, group, and ordering columns.

Example source shape:

```sql
CREATE TABLE public.qa_records (
  id bigint PRIMARY KEY,
  question text NOT NULL,
  answer text NOT NULL,
  category text,
  source_name text,
  source_order integer
);
```

The table and column names must use standard PostgreSQL identifiers (`letters`, `numbers`, `_`, or `$`, beginning with a letter or `_`). Raw SQL is never accepted from the browser.

### 4. Separate pgvector index database

Use a separate PostgreSQL database for the index. It may live in the same PostgreSQL cluster as the source, but the source table is never modified.

The index account needs permission to:

- enable the `vector` extension;
- enable the `pg_trgm` extension;
- create the `semantic_qa` schema;
- create, alter, and drop tool-owned staging/index tables.

If pgvector is already installed at the server level, the UI's **Initialize** action runs:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

If PostgreSQL reports that the extension is unavailable, install pgvector on the database server first. A convenient isolated development option is the official pgvector PostgreSQL image:

```bash
docker run --name semantic-qa-index \
  -e POSTGRES_PASSWORD=semantic-qa-dev \
  -e POSTGRES_DB=semantic_qa_index \
  -p 5433:5432 \
  -d pgvector/pgvector:pg17
```

For this container, use host `127.0.0.1`, port `5433`, database `semantic_qa_index`, user `postgres`, and SSL mode `disable`.

## Local PostgreSQL 18 Demo

This workspace has been verified with Homebrew PostgreSQL 18 on port `5433`, leaving any PostgreSQL server already using `5432` untouched. The local accounts have no passwords and rely on the Homebrew cluster's loopback-only `trust` configuration; do not copy that authentication setup to a network-accessible server.

The ready-to-use configuration is:

| Purpose | Host | Port | Database | User | Password | SSL |
| --- | --- | ---: | --- | --- | --- | --- |
| Source | `127.0.0.1` | `5433` | `semantic_qa_source` | `semantic_qa_reader` | empty | `disable` |
| Vector index | `127.0.0.1` | `5433` | `semantic_qa_index` | `semantic_qa_indexer` | empty | `disable` |

The sample mapping is:

| Setting | Value |
| --- | --- |
| Schema / table | `public.qa_records` |
| Unique ID | `id` |
| Question / answer | `question` / `answer` |
| Metadata | `category`, `source_name` |
| Document group / chunk order | unused |

In the UI, open **Setup** and click **Load sample demo** to apply all of these values.

To recreate the sample databases in the Homebrew 18 cluster, first ensure pgvector is installed and the server is set to port `5433`:

```bash
brew install pgvector
/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -p 5433 -U "$(whoami)" -d postgres \
  -f ./semantic-qa/demo/bootstrap.sql
```

The bootstrap is safe to run again. It creates missing roles/databases, upserts the sample records, grants the read-only source permissions, and enables pgvector in the index database.

Verify the demo directly:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -p 5433 \
  -U semantic_qa_reader -d semantic_qa_source \
  -c 'SELECT COUNT(*) FROM public.qa_records;'

/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -p 5433 \
  -U semantic_qa_indexer -d semantic_qa_index \
  -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

The expected results are `20` source records and pgvector `0.8.5` (or a newer installed version).

## Importing and Extending the Universal Corpus

The importer at `scripts/importUniversalQa.js` creates a PostgreSQL projection from `tblQA` and `tblDiscourse`. It never modifies MySQL, which remains the source of truth. Do not add permanent corpus content directly to PostgreSQL because the next import replaces that projection.

Import behavior:

- writes one `public.corpus_documents` row per original active source document;
- preserves the original field as immutable `raw_content` with a SHA-256 hash;
- creates `display_text` only by deterministic HTML rendering, entity decoding, encoding repair, and layout cleanup;
- never changes spelling, grammar, wording, language, or meaning;
- treats `tblQA.answerBySwami` as one complete `swami_reply`; the title and optional detailed-question fields are discovery context only;
- parses explicit asked/replied pairs in discourses into separate role units;
- treats unmarked discourse preaching as Swami teaching, including when its title looks like a question;
- defaults a missing author to `Swami`;
- reports ambiguous speaker boundaries for review instead of guessing;
- retains legacy chunk aliases so old citations and GPT conversations continue to resolve.

The current corpus contains 419 active Q&As and 5,591 active discourses, for 6,010 original documents. The former v4 projection also keeps its 19,777 chunk aliases temporarily for compatibility and rollback; they are not the primary v5 document structure.

The isolated local configuration is:

| Purpose | Host | Port | Database | User | Password | SSL |
| --- | --- | ---: | --- | --- | --- | --- |
| Imported source | `127.0.0.1` | `5433` | `universal_qa_source` | `semantic_qa_reader` | empty | `disable` |
| Imported vector index | `127.0.0.1` | `5433` | `universal_qa_index` | `semantic_qa_indexer` | empty | `disable` |

The verified local MySQL endpoint is `127.0.0.1:3307`, database `universal`. The password is intentionally never stored in this repository or browser settings. In a terminal, securely place it in the process environment, then run the read-only validation. It reports empty fields, duplicate identities, parsed roles, ambiguous boundaries, hashes, citable units, and proposed document count without writing:

```bash
read -s "UNIVERSAL_MYSQL_PASSWORD?MySQL password: "
export UNIVERSAL_MYSQL_PASSWORD
npm --prefix ./semantic-qa run import:universal:check
```

Then run the repeatable projection:

```bash
npm --prefix ./semantic-qa run import:universal
unset UNIVERSAL_MYSQL_PASSWORD
```

The optional connection environment variables are `UNIVERSAL_MYSQL_HOST`, `UNIVERSAL_MYSQL_PORT`, `UNIVERSAL_MYSQL_USER`, `UNIVERSAL_MYSQL_PASSWORD`, `UNIVERSAL_MYSQL_DATABASE`, `UNIVERSAL_PG_HOST`, `UNIVERSAL_PG_PORT`, `UNIVERSAL_PG_USER`, `UNIVERSAL_PG_PASSWORD`, `UNIVERSAL_PG_DATABASE`, and `UNIVERSAL_INCLUDE_DISCOURSE`.

To add a Q&A, create an active `tblQA` row with a stable ID, `title`, optional `briefQuestion`/`questionBk`, and the complete unchanged answer in `answerBySwami`. To add standalone preaching, create an active `tblDiscourse` row with the topic in `title` and the complete unchanged teaching in `textDC`. Supply `masterId`, `masterLanguage`, date, and media metadata where available. The actual MySQL tables have no separate author column: absence of an explicit leading `[By ...]` byline means Swami, exactly as required. Do not add a byline merely to mark ordinary Swami teaching.

The operational flow is:

```text
Update MySQL
-> import:universal:check
-> import:universal
-> sync:universal:v5
-> review the changed-document and ambiguity report
```

Before any rebuild, run the exact structural preflight:

```bash
npm --prefix ./semantic-qa run preflight:universal:v5
```

The one-time migration from `passage-v4` to `answer-unit-v5` must use **Full rebuild** because the index structure changed. The audited local rebuild can be run without manual field mapping:

```bash
npm --prefix ./semantic-qa run rebuild:universal:v5
```

After v5 is active, Incremental sync rebuilds every answer unit, citable passage, discovery passage, and alias for a changed document while retaining embeddings for unchanged documents. Historical citation aliases are carried forward, including aliases produced by older chunk boundaries. No document has a passage-count cutoff; long discourses are indexed completely.

## Run the Tool

Standalone development mode:

```bash
npm run dev:semantic-qa
```

Open:

```text
http://localhost:5176
```

Standalone production-style mode:

```bash
npm run build:semantic-qa
npm run start:semantic-qa
```

Open `http://localhost:8790`.

Shared workspace mode:

```bash
npm run dev
```

Open `http://localhost:5173/tools/semantic-qa`.

## First-Time Setup

These controls are in the **Search Engine** tool, not the separate GPT Setup screen.

The audited local Universal corpus is already active as `answer-unit-v5` with
6,010 records and 73,587 citable answer passages. Do not run another full
rebuild merely to start using it; open **Index**, click **Refresh status**, and
use **Search** when the state is **Ready**. The steps below are for a new
machine or a deliberately replaced index.

1. Open Search Engine -> **Setup**, click **Load universal Q&A**, and run diagnostics.
2. Confirm that Ollama, `embeddinggemma`, and Qwen are ready.
3. Open Search Engine -> **Settings**.
4. Enter the source PostgreSQL connection and click **Test and discover catalog**.
5. Select the source schema/table and map the unique ID, question, and answer columns.
6. Optionally select metadata. Map document group and chunk order only when several rows are ordered chunks of one original document; never use a category or topic as the group.
7. Enter the separate index PostgreSQL connection and click **Test index database**.
8. Open **Index** and click **Initialize**.
9. Click **Full rebuild** for the first corpus load.
10. Wait for the run to report `completed`, then open **Search**.

After source data changes, use **Incremental sync**. It embeds new or changed records and deletes index rows whose source IDs no longer exist. A failed or cancelled sync leaves the previous live index intact.

After a retrieval change or full rebuild, run the checked-in relevance regression set:

```bash
npm --prefix ./semantic-qa run eval:universal
npm --prefix ./semantic-qa run eval:corpus
npm --prefix ./semantic-qa run eval:promotion:v5
```

The final command is the mandatory live Q8 promotion replay. It requires an activated v5 index and running Search Engine API. It verifies the `related_teachings` outcome, required sources, excluded fragments/experiences, complete story handling, Swami roles, hashes, and exact offsets. Do not activate a staged v5 rebuild unless it passes.

## Connection Settings

You can provide either:

- a complete PostgreSQL connection string; or
- host, port, database, user, password, and SSL mode fields.

For local PostgreSQL, use SSL mode `disable`. `prefer` also falls back to non-SSL for loopback hosts. For hosted PostgreSQL, use the SSL mode required by the provider.

Passwords and complete connection strings remain in browser memory only. They are deliberately removed from local storage, so they must be re-entered after a reload. Non-secret mapping and retrieval preferences are saved locally.

## Retrieval Behavior

The Search screen has two independent retrieval modes:

- **Semantic Search** compares the meaning and intent of the user question with citable Swami answer passages. Dense, lexical, exact-phrase, and fuzzy ranks are fused without allowing discovery-only text to become evidence.
- **Search** performs conventional exact-phrase, full-text, and typo-tolerant retrieval. It does not call the embedding model.

With EmbeddingGemma, each bounded answer passage is embedded using the model's asymmetric document format without the stored question/title:

```text
title:  | text: <answer passage>
```

The user question is embedded as:

```text
task: question answering | query: <user question>
```

Retrieval v5 stores `records` one per document, `answer_units` for complete Swami replies/teachings, `passages` for citable complete logical spans, `discovery_passages` for titles and devotee questions, and `source_aliases` for legacy citations. Discovery hits may nominate a source, after which only that source's Swami answer passages can be cited.

The default clear-match threshold is `0.60`; the universal preset uses `0.49`. Final ordering and clear-match status use the passage relevance score. The API exposes at most one `acceptedMatch`; the UI presents only that record as the best stored source.

With **Verbatim Selection**, deterministic code selects exact stored passages from independently accepted sources. It does not call a generation model and cannot create connective prose.

With **Deep Search**, Qwen first plans focused probes for the practical request, governing principle, qualifications, and counter-teachings. Each probe searches citable answer passages and non-citable discovery passages separately. Deep Search then reconstructs every shortlisted complete Swami unit, runs two independent adjudications, uses a third only on disagreements, groups distinct teachings, and verifies role, context, story completeness, hashes, and offsets. Evidence may be rejected at any phase.

Deep Search uses `qwen3:14b-q8_0` by default and permits `qwen3:14b-q4_K_M` only by explicit choice. Ollama must report the `thinking` capability. Calls use `think: true`, a 32K context, one active generation, a ten-minute per-call limit, and a 45-minute job limit. Reasoning traces are discarded and never returned or persisted. There is no silent fallback to `gemma3:4b`.

Deep results use three honest outcomes: `direct`, `related_teachings`, or `insufficient`. Neutral status and cluster labels may be generated; teaching text may not. Up to two exact primary passages are shown per teaching cluster, with additional verified passages in the evidence section.

Clicking any result source or evidence citation opens the original document and highlights the exact stored offsets. The **Discourses** tab lists synchronized documents independently of retrieval.

When no result meets the threshold, the response begins with:

```text
I could not find a clear answer in the existing data.
```

The closest records are still returned for diagnostics, but the UI keeps them in a collapsed, inspection-only section rather than presenting them as answers. Stored answer text is rendered as plain text with original whitespace and is never evaluated as HTML.

The index stores the immutable Ollama model digest together with the embedding and retrieval format versions. Search is blocked with a full-rebuild instruction if the model tag now resolves to different weights or if application retrieval formats changed. This prevents queries from being compared against an incompatible vector space.

## API

Standalone base path: `/api`

Shared-host base path: `/api/tools/semantic-qa`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Confirm the tool API is running |
| `POST` | `/diagnostics` | Check Ollama, source PostgreSQL, and index PostgreSQL |
| `POST` | `/source/test` | Test source connectivity |
| `POST` | `/source/catalog` | Discover schemas, tables, and columns |
| `POST` | `/index/test` | Test index connectivity and report pgvector status |
| `POST` | `/ollama/test` | Test the configured embedding model |
| `POST` | `/index/initialize` | Create the extension/schema/index objects |
| `POST` | `/index/status` | Read corpus and recent sync status |
| `POST` | `/documents/list` | Page and filter all synchronized discourses |
| `POST` | `/documents/get` | Reconstruct a complete source document and map evidence highlights |
| `POST` | `/sync` | Start an incremental sync or full rebuild |
| `GET` | `/sync/:jobId` | Read an in-memory job status |
| `GET` | `/sync/:jobId/events` | Stream job progress with SSE |
| `POST` | `/sync/:jobId/cancel` | Request cancellation |
| `POST` | `/search` | Run semantic or conventional retrieval and optionally start Verbatim Selection or Deep Search |
| `GET` | `/deep-summary/:jobId` | Read a Deep Search job and final report (legacy-compatible route name) |
| `GET` | `/deep-summary/:jobId/events` | Stream Deep Search operation and elapsed progress with SSE |
| `POST` | `/deep-summary/:jobId/cancel` | Request Deep Search cancellation |

All API routes use the parent workspace's optional `TOOLS_AUTH_TOKEN` protection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot reach Ollama` | Install/start Ollama, verify port `11434`, then pull `embeddinggemma` and `qwen3:14b-q8_0` (or explicitly choose the supported Q4 model). |
| `model ... not found` | Pull the exact model configured in Settings. |
| PostgreSQL `connection refused` or `no response` | Start the database server or correct its host/port. Installing `psql` alone does not start PostgreSQL. |
| `server does not support SSL` | Choose SSL mode `disable` for a local database. |
| `extension "vector" is not available` | Install pgvector on the index database server, then retry Initialize. |
| `extension "pg_trgm" is not available` | Install PostgreSQL contrib extensions on the index server, then retry Initialize. |
| `permission denied to create extension/schema` | Use an index account with setup privileges or have an administrator enable pgvector and create the schema. |
| `Source ID column must be unique` | Select a real unique/primary-key column or expose a database view with a stable unique ID. |
| Empty question/answer errors | Fix the source rows; incomplete records are not silently skipped. |
| Model, model digest, dimension, or retrieval format changed | Select the intended model and run **Full rebuild**. Search intentionally remains blocked until the compatible rebuild completes. |
| Search always reports no clear answer | Confirm the index contains records, then calibrate the relevance threshold using representative questions. |
| Buttons are disabled on Index | Complete the source connection, index connection, and required corpus mapping first. |

## Tests

Run the local suite:

```bash
npm --prefix ./semantic-qa test
```

The real-service integration check is enabled only when all of these are set:

```bash
export SEMANTIC_QA_TEST_SOURCE_URL='postgresql://...'
export SEMANTIC_QA_TEST_INDEX_URL='postgresql://...'
export SEMANTIC_QA_TEST_OLLAMA='http://127.0.0.1:11434'
export SEMANTIC_QA_TEST_MODEL='embeddinggemma' # optional
```

## Current V1 Limits

- One configured corpus per index database
- PostgreSQL sources only
- One unique ID column rather than composite IDs
- Manual full/incremental synchronization
- Loopback Ollama only
- No conversational memory
- Running sync and Deep Search jobs are tracked in memory; persisted sync metadata remains in the index database
