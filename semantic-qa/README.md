# Search Engine

Search Engine (internally still identified as `semantic-qa` for route and settings compatibility) is a retrieval-first question-answer tool. It divides every stored answer into bounded passages, embeds those passages with a local Ollama embedding model, and stores the vectors plus an exact text snapshot in a separate PostgreSQL database. It offers meaning-first Semantic Search, conventional text Search, grounded summaries, and complete source-document viewing.

The tool includes a 20-record sample corpus and local-demo preset. It still requires running PostgreSQL and Ollama services. The **Setup** screen checks each dependency and shows what is missing.

For a newcomer-oriented explanation of Ollama, EmbeddingGemma, model training versus indexing, pgvector, HNSW, cosine similarity, synchronization, multilingual handling, and the complete request flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## What Is Implemented

- PostgreSQL connection testing and source catalog discovery
- Selectable ID, question, answer, metadata, group, and source-order columns
- Local Ollama embeddings through `POST /api/embed`
- pgvector storage with an HNSW cosine index
- Passage-level semantic retrieval across answer text, with PostgreSQL full-text used only to widen recall
- Conventional Search that fuses exact phrases, PostgreSQL full-text rank, and trigram word-distance rank with reciprocal-rank fusion
- Zero question/title weight in passage acceptance, plus document-group deduplication
- Exact quoted-phrase identity checks, so nearby statements with reversed relationships do not outrank the requested quotation
- Atomic full rebuilds and content-hash-based incremental synchronization
- Deletion reconciliation after a successful source scan
- Verbatim stored answers with source IDs and metadata
- Meaning-based evidence pooling across as many as 15 independently relevant records
- Grounded generative summaries that may paraphrase and pool cited evidence across relevant records
- Verified Deep Summary jobs that score the complete answer-passage corpus, validate relevant expansions, hierarchically pool grounded claims, and produce publishable cited prose
- A searchable catalog of all synchronized discourses
- Clickable source citations that reconstruct the full ordered discourse and highlight the cited answer passage
- Deep Summary export to Markdown and browser Print / Save PDF
- Configurable result count and clear-match threshold
- Standalone and shared-workspace operation

Standard Summary never sees retrieval neighbors that failed the clear-match threshold. Deep Summary may inspect those neighbors, but semantic neighbors outside the existing gate and every conventional-search candidate must pass an independent answerability verifier before claim extraction. Both modes treat evidence as quoted data and require resolvable citations. If local summary generation fails, stored results remain available.

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

## Importing the Legacy `universal.sql` Corpus

The importer at `scripts/importUniversalQa.js` converts the legacy `tblQA` and `tblDiscourse` tables into one clean PostgreSQL source projection suitable for embeddings. It does not modify the dump or the imported MySQL tables.

Import behavior:

- includes active, complete rows only (`activeStatus = 1`);
- uses `tblQA.title` / `answerBySwami` for Q&A records;
- uses `tblDiscourse.title` / `textDC` for discourse records;
- converts legacy HTML markup and entities to readable plain text without summarizing or generating content;
- retains the source type, original record ID, master ID, language, date, and chunk position as metadata;
- divides long content at whitespace/paragraph boundaries, using language-aware limits and bounded adjacent-chunk overlap;
- groups chunks by their original Q&A or discourse record and returns them in source order.

For the current dump at `/Applications/XAMPP/xamppfiles/htdocs/universal.sql`, the import includes 419 active Q&As and 5,591 active discourses. With retrieval overlap they produce 19,777 indexed chunks: 956 from `tblQA` and 18,821 from `tblDiscourse`. Inactive records and unrelated Joomla tables are not indexed.

The isolated local configuration is:

| Purpose | Host | Port | Database | User | Password | SSL |
| --- | --- | ---: | --- | --- | --- | --- |
| Imported source | `127.0.0.1` | `5433` | `universal_qa_source` | `semantic_qa_reader` | empty | `disable` |
| Imported vector index | `127.0.0.1` | `5433` | `universal_qa_index` | `semantic_qa_indexer` | empty | `disable` |

Run the repeatable MySQL-to-PostgreSQL projection after importing the dump into the local MySQL database `universal_vector_source`:

```bash
npm --prefix ./semantic-qa run import:universal
```

The optional environment variables are `UNIVERSAL_MYSQL_HOST`, `UNIVERSAL_MYSQL_PORT`, `UNIVERSAL_MYSQL_USER`, `UNIVERSAL_MYSQL_PASSWORD`, `UNIVERSAL_MYSQL_DATABASE`, `UNIVERSAL_PG_HOST`, `UNIVERSAL_PG_PORT`, `UNIVERSAL_PG_USER`, `UNIVERSAL_PG_PASSWORD`, `UNIVERSAL_PG_DATABASE`, `UNIVERSAL_QA_CHUNK_CHARS`, `UNIVERSAL_DISCOURSE_EN_CHUNK_CHARS`, `UNIVERSAL_DISCOURSE_OTHER_CHUNK_CHARS`, `UNIVERSAL_DISCOURSE_EN_OVERLAP_CHARS`, `UNIVERSAL_DISCOURSE_OTHER_OVERLAP_CHARS`, and `UNIVERSAL_INCLUDE_DISCOURSE`.

In the UI, open **Setup**, click **Load universal Q&A**, and run diagnostics. The preset includes the correct source/index connections, mapping, and a corpus-calibrated `0.49` clear-match threshold. After importing changed MySQL data, rerun the projection and use **Incremental sync**.

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

1. Open **Setup** and run diagnostics.
2. Confirm that Ollama and `embeddinggemma` are ready.
3. Open **Settings**.
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
```

The reviewed suite reports source-group and source-record ranks, Recall@5, top-one accuracy, mean reciprocal rank, and the false-accept rate for unanswerable questions. The broader corpus suite replays every available structured-Q&A `source_context` against its own source group and gates top-one recall, top-five recall, and confident wrong answers. Add representative production questions and expected answer records to `semantic-qa/eval/relevance-cases.json`; a relevance threshold alone is not a substitute for these evaluations.

## Connection Settings

You can provide either:

- a complete PostgreSQL connection string; or
- host, port, database, user, password, and SSL mode fields.

For local PostgreSQL, use SSL mode `disable`. `prefer` also falls back to non-SSL for loopback hosts. For hosted PostgreSQL, use the SSL mode required by the provider.

Passwords and complete connection strings remain in browser memory only. They are deliberately removed from local storage, so they must be re-entered after a reload. Non-secret mapping and retrieval preferences are saved locally.

## Retrieval Behavior

The Search screen has two independent retrieval modes:

- **Semantic Search** compares the meaning and intent of the user question with every indexed answer passage. Stored questions and titles do not contribute to semantic acceptance.
- **Search** performs conventional exact-phrase, full-text, and typo-tolerant trigram retrieval over answer passages and titles. Weighted reciprocal-rank fusion combines the independent ranks; exact answer passages receive the strongest weight. It does not call the embedding model.

With EmbeddingGemma, each bounded answer passage is embedded using the model's asymmetric document format without the stored question/title:

```text
title:  | text: <answer passage>
```

The user question is embedded as:

```text
task: question answering | query: <user question>
```

Retrieval v4 scores every indexed answer passage for each Semantic Search and unions relevance-qualified cosine results with full-text passage matches for recall. Acceptance is driven by answer-passage cosine meaning; lexical rank, word overlap, the stored question, and the title all have zero acceptance weight. Only additional semantically supporting passages can add a small bonus. Results are pooled back to their stored source records, and explicit multi-chunk documents are deduplicated. The HNSW path remains as a compatibility fallback when the exhaustive scorer is unavailable.

The default clear-match threshold is `0.60`; the universal preset uses `0.49`. Final ordering and clear-match status use the passage relevance score. The API exposes at most one `acceptedMatch`; the UI presents only that record as the best stored source.

With **Standard Summary**, search internally considers up to 15 passage-ranked records independently. In Semantic Search, a record may enter `relevantMatches` only when it passes the same clear-match threshold and a dense-semantic floor. Only indexed passages from accepted records are sent to the local summary model; rejected neighbors, stored questions, titles, metadata, and source context are excluded.

With **Deep Summary**, semantic mode performs an exact corpus-wide scoring pass over every indexed answer passage instead of stopping at an HNSW candidate cap. Existing threshold-passing semantic evidence remains governed by the same “show relevant only” gate. Lower-scoring but plausible semantic records are separately validated against the exact requested relationship before they can be used. Accepted passages become individually cited claims; large claim sets are hierarchically pooled without dropping their original evidence mappings. The final writer produces one connected, publishable explanation in coherent paragraphs, and the UI places the complete evidence appendix after the prose.

Clicking any result source or evidence citation opens the original discourse reconstructed from every available ordered chunk. Importer overlap is removed at chunk boundaries and the cited chunk-relative offsets are translated into highlights in the reconstructed document. The **Discourses** tab lists all synchronized discourse groups independently of retrieval.

The model may paraphrase and combine the evidence, but every returned citation is validated against an exact passage from an accepted stored answer. It must also state whether the evidence answers the requested relationship or purpose; a related passage about a different use is rejected through the same “show relevant only” result. “How” answers receive an additional adequacy check so a description of the problem cannot masquerade as guidance. If no passage passes semantic admission—or generation fails—the accepted stored answer remains available without a summary.

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
| `POST` | `/search` | Run semantic or conventional retrieval and optionally start Standard or Deep Summary |
| `GET` | `/deep-summary/:jobId` | Read a Deep Summary job and final report |
| `GET` | `/deep-summary/:jobId/events` | Stream Deep Summary progress with SSE |
| `POST` | `/deep-summary/:jobId/cancel` | Request Deep Summary cancellation |

All API routes use the parent workspace's optional `TOOLS_AUTH_TOKEN` protection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot reach Ollama` | Install/start Ollama, verify port `11434`, then pull both configured models (defaults: `embeddinggemma` and `gemma3:4b`). |
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
- Running sync and Deep Summary jobs are tracked in memory; persisted sync metadata remains in the index database
