# mysql-pg-migrate

Web UI and API for planning, validating, provisioning, and executing **MySQL -> PostgreSQL** migrations.

> New here? Start with the full workflow guide: [USAGE.md](./USAGE.md)

This project is no longer just a planner. It already supports:

- MySQL and PostgreSQL connection setup
- schema introspection on both sides
- automatic table and column mapping suggestions
- editable mappings with per-table write settings
- preflight validation and dry-run previews
- target schema provisioning for missing tables/columns
- real data movement from MySQL into PostgreSQL
- checkpointed execution, resume, rerun-failed, and run history
- error capture and basic post-run verification

It is best described today as:

> a working MySQL -> PostgreSQL migration workbench with a practical execution engine — useful now, but not yet a fully hardened enterprise ETL platform

---

## Table of contents

1. [What the tool does today](#what-the-tool-does-today)
2. [Who this tool is for](#who-this-tool-is-for)
3. [Current maturity](#current-maturity)
4. [What you need before starting](#what-you-need-before-starting)
5. [Project structure and ports](#project-structure-and-ports)
6. [How to run the tool](#how-to-run-the-tool)
7. [Quick start](#quick-start)
8. [Workflow overview](#workflow-overview)
9. [Current implemented capabilities](#current-implemented-capabilities)
10. [Current real gaps](#current-real-gaps)
11. [API overview](#api-overview)
12. [Files created by the tool](#files-created-by-the-tool)
13. [Safety tips](#safety-tips)
14. [Recommended next steps](#recommended-next-steps)

---

## What the tool does today

`mysql-pg-migrate` helps you move from a source MySQL schema to a target PostgreSQL schema with a guided workflow:

1. connect to source and target databases
2. introspect schemas and table metadata
3. generate automatic mappings
4. review and edit mappings manually
5. validate compatibility before execution
6. preview transformed rows with dry-run samples
7. provision missing PostgreSQL tables/columns when needed
8. execute the migration in chunks
9. resume interrupted runs and inspect reports/errors

This makes it useful both as:

- a migration planning tool
- a migration execution tool
- an ETL-style validation and run console

---

## Who this tool is for

This tool is meant for:

- developers moving an app from MySQL to PostgreSQL
- engineers who want a UI around schema comparison and data movement
- teams that want to review mappings before loading data
- anyone building a repeatable migration workflow instead of one-off scripts

You do **not** need to be a PostgreSQL expert to start using it, but you should still validate migrations carefully before production cutover.

---

## Current maturity

The README previously understated several capabilities that are already implemented.

### What is already working

The current implementation already includes:

- **driver-based MySQL access via `mysql2`**
- **PostgreSQL access via `pg`**
- **schema introspection** for MySQL and PostgreSQL
- **automatic mapping generation**
- **preflight validation** with blockers and warnings
- **dry-run previews** using transformed sample rows
- **real data writes to PostgreSQL**
- **checkpoint persistence**
- **resume support**
- **keyset resume for single-column primary-key tables**
- **table-scoped consistent-read execution sessions when enabled**
- **FK-aware execution ordering**
- **basic target schema provisioning**
- **run reports, stored errors, and row-count verification support**
- **conflict-key inference from mapped PK/unique key candidates**
- **row filters and conditional transform support**
- **constraint-planning visibility for schema provisioning**
- **guarded execution using verification fingerprints**
- **cutover-readiness reporting**
- **throughput telemetry per processed table**
- **execution metadata for write-mode guarantees and reconciliation summaries**

### What it still is not

This is still **not yet a fully production-hardened migration platform**.

The biggest remaining gaps are around:

- consistency guarantees while source data is changing
- stronger idempotent resume semantics
- advanced reconciliation and validation
- richer ETL transforms
- throughput/parallelism at larger scale

So the right framing today is:

> practical and useful for real migrations, but still in the hardening phase for large, high-risk, or near-zero-downtime workloads

---

## What you need before starting

You should have:

### 1. Node.js / npm available

This project is run with npm scripts.

### 2. Access to a MySQL database

You need:

- host
- port
- username
- password
- database name
- optionally schema information

### 3. Access to a PostgreSQL database

You need either:

- a full PostgreSQL connection string

or:

- host
- port
- username
- password
- database name

### 4. Correct credentials

If the credentials are wrong, schema listing and introspection will fail.

### 5. A test/staging target is strongly recommended

Even though the execution engine can now move real data, it is still best practice to test all database migration work on non-production systems first.

---

## Project structure and ports

This tool lives in:

```text
mysql-pg-migrate/
```

Default ports:

- **Dev UI:** `5175`
- **Standalone app/API:** `8789`

Useful URLs:

- Dev UI: `http://localhost:5175`
- Standalone app/API: `http://localhost:8789`
- Health endpoint: `http://localhost:8789/api/health`

---

## How to run the tool

You can run it in three common ways.

---

### Option 1: Development mode from repo root

From the repo root:

```bash
npm --prefix ./mysql-pg-migrate run dev
```

This starts:

- the Express API server
- the Vite development UI

Then open:

- `http://localhost:5175`

---

### Option 2: Development mode from inside the folder

```bash
cd mysql-pg-migrate
npm run dev
```

---

### Option 3: Production-style run

From repo root:

```bash
npm --prefix ./mysql-pg-migrate run build
npm --prefix ./mysql-pg-migrate run start
```

Or from inside the tool folder:

```bash
cd mysql-pg-migrate
npm run build
npm run start
```

Then open:

- `http://localhost:8789`

Use this mode if you want the built static frontend served by the Express server.

---

### Option 4: Preview the build

```bash
cd mysql-pg-migrate
npm run preview
```

Open:

- `http://localhost:5175`

---

## Quick start

If you are completely new, do this first:

1. Start the tool in dev mode:

   ```bash
   npm --prefix ./mysql-pg-migrate run dev
   ```

2. Open the UI in your browser:

   ```text
   http://localhost:5175
   ```

3. Go to the **Workspace** tab.

4. Enter:
   - a project name
   - your MySQL connection details
   - your PostgreSQL connection details

5. Click **Load schemas** for source and target.

6. Choose the source schema and target schema.

7. Click **Introspect schemas**.

8. If that works, click **Create auto-mapped project**.

9. Go to **Mapping** and review the suggested table/column matches.

10. Go to **Validate & Run** and run:
    - **Run preflight**
    - **Build dry run**

11. Review warnings/blockers.

12. If everything looks good, start a run with **Execute migration**.

---

## Workflow overview

### 1. Workspace

Use this tab to:

- define project name
- enter MySQL and PostgreSQL connection information
- load available schemas
- introspect both catalogs
- create a persisted project with auto-generated mappings

### 2. Mapping

Use this tab to:

- review table matches
- enable or disable tables
- set target tables
- choose write mode
- set conflict keys for upsert flows
- tune chunk size
- adjust per-column mappings and transforms
- save or regenerate mappings

### 3. Validate & Run

Use this tab to:

- run preflight analysis
- inspect dry-run previews
- configure run options
- execute migration
- resume interrupted runs
- rerun failed work
- watch live logs and progress events

### 4. History

Use this tab to:

- browse saved projects
- export/import mapping JSON
- inspect previous runs and reports

### 5. Settings

Use this tab to communicate operational expectations and current tool status.

---

## Current implemented capabilities

### Connectivity and introspection

- MySQL connectivity uses **`mysql2/promise`**
- PostgreSQL connectivity uses **`pg`**
- source and target schemas can be listed from the UI/API
- schema introspection captures tables, columns, indexes, and foreign keys

### Mapping and planning

- automatic table and column mapping suggestions
- editable mappings with enable/disable support
- configurable write mode and conflict keys
- persisted project state and mapping export/import

### Validation and dry-run

- preflight compatibility analysis
- blocker and warning reporting
- transform validation against sample rows
- dry-run previews showing transformed output shape
- transform presets plus richer transform types including lookup, expression, concat, coalesce, and conditional
- row-filter evaluation for preview and execution

### Execution engine

- real row reads from MySQL
- chunked writes to PostgreSQL
- append, truncate-style, and upsert-oriented flows
- checkpoint persistence
- resume support for interrupted runs
- rerun-failed workflow
- quarantine-style row handling through stored error records
- chunk fingerprint tracking for basic duplicate-replay protection
- execution-profile metadata that records run mode, error policy, selected tables, and consistent-read settings
- configurable concurrency and batched PostgreSQL writes
- pooled PostgreSQL writes and dependency-layered execution
- watermark-filtered incremental reads with tie-breaker handling groundwork
- guarded execution using verification fingerprints
- throughput rows/second telemetry per table

### Execution planning

- FK-aware table ordering is already implemented
- dependency cycles are detected and surfaced as warnings
- single-column primary key tables can use **keyset-based progression/resume**
- other tables fall back to offset-based paging

### Target schema provisioning

- MySQL columns can be mapped into PostgreSQL column definitions
- the tool can generate provisioning plans for missing target tables/columns
- the tool can generate and apply basic `CREATE TABLE` / `ALTER TABLE ADD COLUMN` statements
- provisioning now also plans secondary indexes, unique constraints, foreign-key follow-up actions, and enum migration notes for created tables

### Verification and reporting

- run records, reports, checkpoints, and error records are persisted on disk
- basic post-run verification can compare source and target row counts
- per-table statuses, inserted counts, and rejected counts are recorded
- reconciliation summaries now include mismatch counts, anomaly rollups, and consistency mode labels
- audit reporting includes confidence scoring and actionable recommendations
- cutover-readiness reports summarize readiness state, mismatches, replayable errors, consistency mode, and CDC mode

### Rejected-row workflows

- row-level write/transform failures retain row payload context where available
- stored errors can be inspected per run
- errors can be exported as JSON for offline repair/replay workflows
- replay guidance now identifies replayable write failures and produces a manual replay plan
- corrected replay payloads can now be imported and replayed into the target database
- replay history is now persisted and visible per run
- replay records now retain replay classifications for better remediation context

### Consistent-read groundwork

- source connections can optionally request a MySQL **consistent read** session
- current implementation supports transaction start with `REPEATABLE READ` / `START TRANSACTION WITH CONSISTENT SNAPSHOT` groundwork
- this is an operational foundation, not yet a full CDC or cross-run snapshot orchestration layer

### Wave-3 operational controls

- configurable execution concurrency
- batched target writes
- CDC mode flags (`off`, `snapshot-only`, `watermark`) for workflow expansion
- cutover mode flags (`manual`, `guarded`) surfaced in execution metadata and reports
- dependency-layered scheduler groundwork for safer parallelism
- watermark execution now requires a stable tie-breaker column
- guarded execution now rejects stale verification state
- cutover-readiness summary endpoint and UI support

### Incremental execution relevance

- when `cdcMode=watermark`, source reads use saved high watermark plus tie-breaker state to fetch only newer rows
- checkpoints persist `highWatermark` and `highWatermarkTieBreaker` values per table
- preflight warns when watermark mode lacks a suitable source column or stable PK tie-breaker
- run reports surface replay counts, scheduler mode, execution layers, watermark metadata, concurrency, batching details, and throughput metrics

---

## Full UI guide

The app currently has five main tabs:

- Workspace
- Mapping
- Validate & Run
- History
- Settings

---

## Workspace tab

This is where you set up the migration context.

### What you do here

- name your migration project
- enter source MySQL connection details
- enter target PostgreSQL connection details
- load schema names from each side
- choose source and target schemas
- introspect catalogs
- create a saved auto-mapped project

### Fields you will see

#### Project name

Example:

```text
billing-mysql-to-pg
```

This is just a label to help you identify the migration project later.

#### Source MySQL section

You can enter:

- Host
- Port
- User
- Database
- SSL mode
- Reference
- Password
- Connection string (optional reference field)
- Schema

**Tip for beginners:**

If you do not know the port:

- MySQL usually uses `3306`

#### Target PostgreSQL section

You can enter:

- Connection string
- Host
- Port
- User
- Database
- SSL mode
- Reference
- Password
- Schema

**Tip for beginners:**

If you do not know the port:

- PostgreSQL usually uses `5432`

### Buttons in this tab

#### Load schemas

This asks the backend to connect to the database and return the available schemas.

Use it when:

- you want to verify connection credentials
- you need to choose the correct schema

#### Introspect schemas

This performs a deeper inspection of:

- tables
- columns
- other catalog information

After a successful introspection, you will see source and target catalog JSON previews.

#### Create auto-mapped project

This does several things:

1. introspects source and target
2. compares names/types
3. generates suggested table mappings
4. generates suggested column mappings
5. saves the project into the tool’s local state store

This is the main entry point into the rest of the workflow.

---

## Mapping tab

This is where you review and adjust the suggested mappings.

### What you do here

- select a project
- review table matches
- enable/disable tables
- choose target table names manually
- choose write mode
- choose conflict strategy
- adjust chunk sizes
- choose conflict keys
- review/edit column mappings
- save the edited project

### Key concepts

#### Table mapping

A table mapping means:

> “Rows from MySQL table A are expected to go into PostgreSQL table B.”

#### Column mapping

A column mapping means:

> “MySQL column X should populate PostgreSQL column Y.”

### Important fields

#### Enabled

If enabled is unchecked, that table will not be included in a run.

This is useful when:

- you want to migrate only part of a schema
- some tables are not ready yet

#### Target table

If the tool guessed the wrong table, choose the correct one manually.

#### Write mode

Currently available values:

- `append`
- `truncate`
- `upsert`

These represent the intended write behavior for the migration.

#### Conflict strategy

Possible values:

- `insert`
- `upsert`
- `truncate-load`

These describe what the migration should do when rows may conflict.

#### Chunk size

This is the planned batch size for processing rows.

Example:

- `500`

Smaller chunk sizes can reduce risk during real migrations; larger chunk sizes may be faster.

#### Conflict keys

These are key columns used for matching conflicts.

Example:

```text
id
```

or

```text
id,external_id
```

### Save project

Always click **Save project** after making mapping changes.

If you do not save, your current edits may not be reflected in later preflight or run steps.

### Re-run auto map

Use this if:

- you want to reset mappings to the latest auto-generated suggestion
- you changed source/target understanding and want fresh suggestions

Be careful: re-running auto map may overwrite manual mapping edits.

---

## Validate & Run tab

This is where you test whether the migration plan is sensible.

### What you do here

- run preflight checks
- generate dry-run previews
- configure run options
- start a run
- monitor progress/logs
- inspect run history and reports
- resume runs
- rerun failed tables

---

### Preflight report

Click **Run preflight**.

This checks for things like:

- missing target tables
- missing target columns
- incompatible data types
- risky casts
- required transforms
- required but unmapped target columns
- suspicious boolean-like values in sampled data

#### Why preflight matters

This is one of the most important steps.

It helps answer:

- “Will the current mappings work?”
- “What is broken before I attempt a run?”
- “What needs manual attention?”

If preflight shows blockers, fix them in **Mapping** before going further.

---

### Dry run preview

Click **Build dry run**.

This shows:

- sampled source rows
- how the current mapping would transform those rows into target-shaped rows

This is useful because it helps beginners see:

- what columns are included
- what values are ignored
- where transforms may be needed

---

### Execute migration

You can configure:

- **Run mode**
  - `all`
  - `selected`
- **Error policy**
  - `fail-fast`
  - `quarantine`
- **Selected tables**
- **Mark execution as dry run**

Then click **Execute migration**.

### Important note again

At the moment, execution:

- creates a run record
- emits progress
- stores checkpoints
- stores reportable state

but it still has important operational limitations and should be validated carefully before production use.

Treat it as an early-stage migration engine for now.

---

### Resume

If a run stops or is incomplete, click **Resume**.

The backend will try to continue from unfinished tables.

### Rerun failed

If a run has failed tables, click **Rerun failed**.

This creates a new run focused only on failed tables.

---

### Live logs

The logs section displays server-sent events emitted by the backend.

This helps you see:

- status changes
- run progress
- per-table updates
- log lines from the execution engine

---

## History tab

This tab gives you access to saved project and run history.

### What you can do here

- review saved projects
- export project mappings as JSON
- import project mappings from JSON
- browse previous runs
- quickly reload a project or run

### Export project

This downloads a project definition as:

```text
<project-id>.mapping.json
```

Use this when you want to:

- back up your mapping work
- share a migration project with someone else
- move project configuration between environments

### Import project

Paste a previously exported project JSON and click **Import project**.

This restores the project into the tool’s stored state.

---

## Settings tab

This tab explains the current state of the tool.

It is especially useful for beginners because it clarifies:

- what the tool is really doing today
- where data is stored
- what limitations still exist

---

## Understanding the migration workflow

If you are new to database migration, here is the big-picture process:

### Step 1: Connect to both databases

The tool needs access to:

- where data comes from (MySQL)
- where data is intended to go (PostgreSQL)

### Step 2: Inspect the schemas

The tool compares source and target structures.

Questions it tries to answer:

- Do both sides have similar tables?
- Do column names match?
- Are data types compatible?

### Step 3: Build mappings

The tool guesses:

- which source table matches which target table
- which source column matches which target column

These are only suggestions. You should review them.

### Step 4: Validate before running

This is where preflight and dry-run help.

They help you catch problems early.

### Step 5: Run the workflow

Currently this performs real migration work, but still with important operational limitations.

### Step 6: Inspect reports/history

You use reports and history to understand what happened and what still needs work.

---

## Example beginner workflow

Here is a simple example.

Let’s say you have:

- MySQL database: `shop_mysql`
- PostgreSQL database: `shop_pg`

### In Workspace

Set:

- Project name: `shop-migration`
- MySQL host: `127.0.0.1`
- MySQL port: `3306`
- MySQL user: `root`
- MySQL password: `your-password`
- MySQL database: `shop_mysql`
- PostgreSQL host: `127.0.0.1`
- PostgreSQL port: `5432`
- PostgreSQL user: `postgres`
- PostgreSQL password: `your-password`
- PostgreSQL database: `shop_pg`

Then:

1. click **Load schemas** on both sides
2. choose your schemas
3. click **Introspect schemas**
4. click **Create auto-mapped project**

### In Mapping

Check:

- `users` → `users`
- `orders` → `orders`
- `order_items` → `order_items`

If `cust_name` should map to `customer_name`, fix it manually.

Then click **Save project**.

### In Validate & Run

1. click **Run preflight**
2. check blockers/warnings
3. go back and fix mappings if needed
4. click **Build dry run**
5. inspect sample transformed rows
6. when satisfied, click **Execute migration**

### In History

You can:

- review the project later
- export the mapping JSON
- inspect the run status

---

## API overview

The UI talks to the backend using `/api` routes.

Important endpoints include:

### Health

```http
GET /api/health
```

### Load source schemas

```http
POST /api/connections/source/schemas
```

### Load target schemas

```http
POST /api/connections/target/schemas
```

### Introspect both sides

```http
POST /api/introspect
```

### Create project

```http
POST /api/projects
```

### List projects

```http
GET /api/projects
```

### Update project

```http
PUT /api/projects/:id
```

### Re-run auto-map

```http
POST /api/projects/:id/auto-map
```

### Preflight

```http
POST /api/projects/:id/preflight
```

### Dry run

```http
POST /api/projects/:id/dry-run
```

### Execute

```http
POST /api/projects/:id/execute
```

### Resume run

```http
POST /api/runs/:id/resume
```

### Rerun failed

```http
POST /api/runs/:id/rerun-failed
```

### Run report

```http
GET /api/runs/:id/report
```

### Run event stream

```http
GET /api/runs/:id/events
```

### Export project JSON

```http
GET /api/projects/:id/export
```

### Import project JSON

```http
POST /api/projects/import
```

---

## Files created by the tool

The tool stores state in:

```text
mysql-pg-migrate/state/
```

Main folders:

- `state/projects/` → saved project definitions
- `state/runs/` → run records
- `state/reports/` → preflight/dry-run reports
- `state/checkpoints/` → run progress checkpoints
- `state/errors/` → error records

This means your work is not only kept in browser memory; the backend also persists project/run state on disk.

---

## Troubleshooting

Here are the most common issues beginners may face.

### 1. UI opens but schema loading fails

Possible causes:

- wrong host
- wrong port
- wrong username/password
- database not reachable
- firewall or local networking issue

What to do:

- recheck credentials
- make sure the database is running
- confirm the database accepts connections from your machine

---

### 2. Source schemas or target schemas dropdown is empty

Possible causes:

- wrong database selected
- credentials do not have permission to list schemas
- no password entered

What to do:

- verify database name
- verify permissions
- try again after filling password

---

### 3. Introspection fails

Possible causes:

- one or both connections are invalid
- schema name is invalid
- backend cannot read metadata from the database

What to do:

- load schemas first
- select valid schema names
- try with simpler/default schema names first

---

### 4. Auto mapping looks wrong

That is normal sometimes.

Auto-mapping is based on:

- normalized names
- singular/plural matching
- token similarity
- some type similarity

What to do:

- manually adjust target tables
- manually adjust target columns
- save your project after editing

---

### 5. Preflight shows blockers

This usually means the current mapping is incomplete or incompatible.

Examples:

- missing target table
- missing target column
- incompatible source/target types
- required target column not mapped

What to do:

- go back to **Mapping**
- fix table/column mappings
- rerun preflight

---

### 6. Execute run completed, but the result is not what I expected

This is expected with the current implementation.

Possible reasons:

- mappings were incorrect
- required target columns were not mapped properly
- transform errors caused rejected rows
- upsert/conflict key setup was wrong
- source data changed during the run
- chunk-level progress completed, but the migrated result still needs verification

---

### 7. Build works but app seems stale

If using production mode:

```bash
npm --prefix ./mysql-pg-migrate run build
npm --prefix ./mysql-pg-migrate run start
```

Rebuild after frontend changes so `public/` gets updated.

---

## Safety tips

Even beginners should follow these rules:

1. **Never start with production data first.**
2. **Test using a staging or copy database.**
3. **Review mappings manually.**
4. **Always run preflight before execution.**
5. **Use dry-run previews to inspect transformed sample rows.**
6. **Export project JSON as backup before major mapping changes.**
7. **Do not assume auto-mapping is perfect.**

---

## Current real gaps

This section is especially important.

### 1. No full run-wide consistent snapshot strategy yet

The tool now supports **table-scoped** MySQL consistent-read execution sessions when enabled, which is a meaningful correctness improvement for individual table loads.

Still missing:

- coordinated **cross-table** snapshot semantics for a whole run
- run-wide snapshot orchestration across all tables
- CDC or catch-up flows for low-downtime cutover

Wave-4 improvement already added:

- dependency-layered scheduler groundwork
- watermark-column tracking in checkpoints/report metadata
- watermark-based filtered reads for incremental catch-up groundwork

### 2. Resume semantics are better defined, but not fully hardened

Resume is better than before because checkpoints exist, some tables can use keyset progress, deterministic chunk ids are now persisted, and write-mode safety metadata is recorded. It is still not enterprise-grade.

Wave-1 improvement already added:

- duplicate chunk replay detection using chunk fingerprints at checkpoint boundaries
- deterministic chunk ids persisted in checkpoints
- write-mode safety metadata persisted for recovery decisions

Still missing:

- stronger end-to-end idempotency guarantees
- safer replay handling after partial writes at target transaction boundaries
- deterministic recovery under source churn across full multi-table runs

### 3. Reconciliation is stronger, but still not comprehensive

The tool already supports row-count-style validation, but not a full trust-building reconciliation framework.

Wave-1 improvement already added:

- anomaly rollups
- mismatch counts
- execution-profile and consistency-mode reporting
- confidence / trust-level reporting in audit output
- cutover-readiness summaries and trust states in validation output

Still missing:

- real checksums or hashes
- real aggregate parity checks
- FK integrity validation after load
- deeper cutover-readiness scoring backed by stronger reconciliation rules

### 4. Transform support is richer, but not full ETL-grade

Current built-in transforms include:

- direct
- string
- number
- boolean
- json
- date
- datetime
- constant
- null
- template
- lookup
- expression
- concat
- coalesce
- conditional

The tool now also supports:

- row filtering using table-level expressions
- transform presets with richer metadata
- transform rule validation during preflight/dry-run

Still missing:

- reusable transform libraries/presets
- advanced multi-column derivations
- row filtering and conditional routing

### 5. Upsert behavior is better, but still not fully automatic

Upsert exists, and the tool now infers conflict-key candidates from mapped primary keys / unique keys where possible. Operators still need to verify the inferred result.

Still missing:

- richer merge/update policies
- conditional upsert strategies
- stronger runtime proof that inferred keys match the intended business key

### 6. Schema migration support is still partial

The tool can already provision missing tables and columns, and it now plans unique constraints and foreign-key follow-up actions. It is still not yet a full schema migration engine.

Still missing:

- full index and constraint parity with safe dependency orchestration
- native enum strategies
- sequence/identity migration refinements
- trigger/function/procedure migration
- richer default-expression compatibility handling

### 7. Constraint-sensitive loading is incomplete

There is already FK-aware ordering, which is a good step forward.

Still missing:

- constraint deferral strategies
- robust handling of cycles
- phased parent/child loading modes

### 8. Throughput and scale hardening are improving, but still limited

Execution is still primarily table-by-table and chunk-by-chunk.

Wave-3 improvement already added:

- configurable concurrency for table execution
- configurable batch size for PostgreSQL writes
- per-table throughput telemetry
- cutover/guarded execution metadata

Still missing:

- tunable concurrency
- streaming-oriented optimizations
- richer batching and connection reuse strategies

### 9. Error recovery UX is still basic

The tool stores error records and can continue in quarantine-style paths, but the operator experience is still minimal.

Wave-4 improvement already added:

- replay import endpoint
- replay history persistence
- corrected-row replay workflow against the target

Still missing:

- rejected-row inspection workflows
- dead-letter style handling
- corrected-row reprocessing

Current note:

- replay now exists, but it still depends on manually prepared correction payload JSON rather than a first-class guided repair UI

### 10. Imported project JSON is trusted too easily

Import/export is useful, but project import is not yet hardened with stronger validation or policy controls.

---

## Recommended next steps

If the goal is to turn this into a best-in-class MySQL -> PostgreSQL ETL tool, prioritize work in this order.

### P0 - correctness and trust

1. **Harden resume and idempotency semantics**
   - persist high-watermark state more explicitly
   - make partial reruns deterministic
   - reduce duplicate-write risk after interruption

2. **Add stronger reconciliation**
   - row counts per table
   - checksums/hashes on key columns
   - anomaly summaries for mismatches

3. **Formalize execution guarantees by write mode**
   - append
   - truncate-load
   - upsert
   - each should clearly state recovery behavior and operator expectations

4. **Add consistent-read strategy for MySQL**
   - transaction/snapshot approach where feasible
   - documented operational mode for stable migrations

### P1 - ETL depth

1. **Build a richer transform framework**
   - expression transforms
   - lookup transforms
   - reusable named presets
   - conditional transforms and row filters

2. **Extend schema provisioning**
   - indexes
   - constraints
   - enum handling
   - identity/sequence parity

3. **Improve rejected-row workflows**
   - export rejected rows
   - inspect and repair failures
   - replay corrected rows

4. **Improve reporting UX**
   - cutover confidence summary
   - per-table readiness indicators
   - downloadable migration audit report

### P2 - scale and cutover readiness

1. **Add parallel execution**
2. **Improve batching and connection reuse**
3. **Add incremental sync / CDC support**
4. **Add cutover-oriented validation and operational controls**

---

## Latest status snapshot

As of the latest implementation pass, `mysql-pg-migrate` now includes:

- Wave 1: correctness/trust improvements around consistency, resume semantics, conflict-key inference, and trust reporting
- Wave 2: transform presets, richer transforms, row filters, schema planning improvements, replay metadata, and import validation hardening
- Wave 3: concurrency controls, batching, dependency-layered execution, watermark tie-breaker handling, guarded execution, throughput telemetry, and cutover-readiness reporting

That means the product is now best described as:

> a serious migration workbench with practical ETL execution, staged recovery tooling, and early incremental-sync support — but still not a full enterprise-grade CDC/cutover platform

---

## Summary

`mysql-pg-migrate` has already moved beyond a simple planner. It is now a real migration workbench with:

- planning
- mapping
- validation
- provisioning
- execution
- resume
- reporting

The next leap is not “make it work at all” — it already works.

The next leap is:

> make it trustworthy, repeatable, reconcilable, and scalable enough for serious production migrations