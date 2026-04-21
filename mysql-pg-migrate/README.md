# mysql-pg-migrate

Beginner-friendly web UI and API for planning and managing a **MySQL → PostgreSQL migration workflow**.

This tool helps you:

- connect to a source MySQL database
- connect to a target PostgreSQL database
- inspect schemas on both sides
- generate automatic table/column mapping suggestions
- review and edit mappings
- run preflight checks
- build dry-run previews
- start and monitor migration runs
- resume or rerun failed runs
- export and import project mapping JSON

---

## Important: what this tool can and cannot do today

Before you use the tool, please understand one very important limitation:

### What works today

The tool **does provide a real UI and API workflow** for:

- schema introspection
- automatic mapping generation
- project persistence
- mapping review/editing
- preflight analysis
- dry-run preview generation
- run orchestration
- run history/report viewing

### What does not fully work yet

The current backend execution engine is **still a simulation**.

That means:

- the UI behaves like a migration tool
- runs are created and tracked
- progress/log/status events are emitted
- checkpoints/reports are stored
- but the backend does **not yet perform real row-by-row data copy from MySQL into PostgreSQL**

So today, you should treat this tool as:

> a migration planning, validation, mapping, and workflow management tool — **not yet a final production-grade data mover**

If you are a beginner, this is still very useful because it helps you understand and prepare the migration process safely.

---

## Table of contents

1. [Who this tool is for](#who-this-tool-is-for)
2. [What you need before starting](#what-you-need-before-starting)
3. [Project structure and ports](#project-structure-and-ports)
4. [How to run the tool](#how-to-run-the-tool)
5. [First-time quick start](#first-time-quick-start)
6. [Full UI guide](#full-ui-guide)
   - [Workspace tab](#workspace-tab)
   - [Mapping tab](#mapping-tab)
   - [Validate & Run tab](#validate--run-tab)
   - [History tab](#history-tab)
   - [Settings tab](#settings-tab)
7. [Understanding the migration workflow](#understanding-the-migration-workflow)
8. [Example beginner workflow](#example-beginner-workflow)
9. [API overview](#api-overview)
10. [Files created by the tool](#files-created-by-the-tool)
11. [Troubleshooting](#troubleshooting)
12. [Safety tips](#safety-tips)
13. [Current limitations](#current-limitations)

---

## Who this tool is for

This tool is meant for:

- developers moving an app from MySQL to PostgreSQL
- engineers who want to inspect schema compatibility
- beginners who need help understanding how a migration should be organized
- anyone who wants a UI around migration planning instead of only raw scripts

You **do not need to be a database expert** to start using it.

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

Even though the execution engine is currently simulated, it is best practice to test all database migration work on non-production systems first.

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

## First-time quick start

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

Again: today, this final run is a **workflow simulation**, not a real full data transfer.

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

but **does not yet perform a true full data move into PostgreSQL**.

Treat it as a run workflow simulator for now.

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

Currently this simulates a migration run and tracks execution state.

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

### 6. Execute run completes but target database did not really change

This is expected with the current implementation.

Why:

- the execution engine is still simulated
- it tracks workflow state but does not yet do real copy into PostgreSQL

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

## Current limitations

This section is especially important.

### Limitation 1: execution is simulated

The biggest limitation today is that execution tracking exists, but true row transfer logic is not fully implemented.

### Limitation 2: not yet integrated into shared host routes

At the moment this tool is standalone.

It is not yet wired into routes like:

- `/tools/pg-backup`
- `/tools/mysql-tool`

### Limitation 3: mapping suggestions are heuristic

Suggestions are helpful, but they are not guaranteed to be correct.

### Limitation 4: project import accepts JSON as-is

You should only import JSON you trust.

---

## Summary

`mysql-pg-migrate` is currently best used as a:

- migration planning tool
- schema comparison tool
- mapping editor
- validation/preflight tool
- dry-run preview tool
- run orchestration/history UI

If you are a beginner, the best path is:

1. connect databases
2. introspect schemas
3. create project
4. review mappings
5. run preflight
6. inspect dry-run
7. use execution/history for workflow validation

If you want, I can also create:

- a **short quickstart version** of this guide
- an **API-only usage guide**
- a **step-by-step tutorial with sample MySQL/Postgres schemas**
- a **screenshots-ready user manual format**