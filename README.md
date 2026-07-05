# Tools Workspace

This repository is a local web workspace for database utilities. It has a shared React/Express host plus three tools:

| Tool | Purpose | Standalone UI | Standalone API | Shared-host route |
| --- | --- | --- | --- | --- |
| `pg-backup` | PostgreSQL backup runner, schema snapshot, schema visualizer, history, settings | `http://localhost:5173` | `http://localhost:8787/api` | `/tools/pg-backup` |
| `mysql-tool` | MySQL backup runner, history, settings | `http://localhost:5174` | `http://localhost:8788/api` | `/tools/mysql-tool` |
| `mysql-pg-migrate` | MySQL-to-PostgreSQL migration workbench | `http://localhost:5175` | `http://localhost:8789/api` | `/tools/mysql-pg-migrate` |

The shared host runs all tools from one UI:

```text
http://localhost:5173
```

In production-style mode, the shared host serves the built UI and APIs from:

```text
http://localhost:8787
```

## Current Status

The tools are useful, but they are local operational tools rather than hardened multi-user services. Treat database credentials, backups, migration state, dry-run reports, and exported error payloads as sensitive.

The implementation gaps found while writing this guide are tracked separately in [IMPLEMENTATION_GAPS.md](./IMPLEMENTATION_GAPS.md).

## Repository Layout

```text
.
|-- package.json                  # Shared host scripts
|-- vite.config.js                # Shared host Vite config
|-- src/
|   |-- server.js                 # Shared Express host
|   `-- ui/                       # Shared React shell and tool registry
|-- public/                       # Built shared-host UI
|-- pg-backup/
|   |-- src/server.js             # Standalone PostgreSQL backup API/UI server
|   |-- src/registerRoutes.js     # PostgreSQL backup API routes
|   |-- src/backupRunner.js       # pg_dump/psql orchestration
|   |-- src/ui/                   # PostgreSQL backup UI
|   |-- backups/                  # Generated PostgreSQL backup folders/zips
|   `-- pgbackup.profiles.json    # Optional profile template file
|-- mysql-tool/
|   |-- src/server.js             # Standalone MySQL backup API/UI server
|   |-- src/registerRoutes.js     # MySQL backup API routes
|   |-- src/backupRunner.js       # mysqldump/mysql orchestration
|   |-- src/ui/                   # MySQL backup UI
|   |-- backups/                  # Generated MySQL backup folders/zips
|   `-- mysqltool.profiles.json   # Optional profile template file
`-- mysql-pg-migrate/
    |-- src/server.js             # Standalone migration API/UI server
    |-- src/registerRoutes.js     # Migration API routes
    |-- src/lib/                  # Introspection, transforms, preflight, execution
    |-- src/state/persistence.js  # JSON persistence layer
    |-- src/ui/                   # Migration workbench UI
    |-- state/                    # Projects, runs, checkpoints, reports, errors
    `-- test/                     # Current migration tests
```

## Prerequisites

Install Node.js and npm first.

For PostgreSQL backups:

```bash
brew install postgresql@16
brew link --force postgresql@16
```

Verify:

```bash
pg_dump --version
psql --version
```

Optional explicit paths:

```bash
export PG_DUMP_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
export PSQL_PATH="/opt/homebrew/opt/postgresql@16/bin/psql"
export PG_DUMPALL_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dumpall"
```

For MySQL backups:

```bash
brew install mysql-client
```

Verify:

```bash
mysql --version
mysqldump --version
```

Optional explicit paths:

```bash
export MYSQL_PATH="/opt/homebrew/opt/mysql-client/bin/mysql"
export MYSQLDUMP_PATH="/opt/homebrew/opt/mysql-client/bin/mysqldump"
```

For MySQL-to-PostgreSQL migrations, the tool connects through Node drivers:

- MySQL: `mysql2`
- PostgreSQL: `pg`

It does not require `mysqldump`, `mysql`, `pg_dump`, or `psql` for the migration workflow.

## Install

Recommended bootstrap from the repository root:

```bash
npm install
npm --prefix ./pg-backup install
npm --prefix ./mysql-pg-migrate install
```

Notes:

- Root and subtool scripts use `src/runPackageBin.js` to resolve local package binaries without hard-coding a particular `node_modules` folder.
- `mysql-tool` and `mysql-pg-migrate` can fall back to dependencies installed under `pg-backup` for shared packages.
- `mysql-pg-migrate` still needs its own install because it depends on `mysql2`.

If you want `mysql-tool` to have local dependencies too, run:

```bash
npm --prefix ./mysql-tool install
```

## Running The Shared Host

Development mode:

```bash
npm run dev
```

This is the same as:

```bash
npm run dev:all
```

Open:

```text
http://localhost:5173
```

Shared-host tool routes:

```text
http://localhost:5173/tools/pg-backup
http://localhost:5173/tools/mysql-tool
http://localhost:5173/tools/mysql-pg-migrate
```

The Vite dev server proxies `/api` to the shared Express host on `8787`.

Production-style shared host:

```bash
npm run build
npm run start
```

Open:

```text
http://localhost:8787
```

Health and registry:

```text
http://localhost:8787/api/health
http://localhost:8787/api/tools
```

## Running Tools Standalone

### PostgreSQL Backup

```bash
npm run dev:pg-backup
```

Open:

```text
http://localhost:5173
```

API health:

```text
http://localhost:8787/api/health
```

Production-style:

```bash
npm run build:pg-backup
npm run start:pg-backup
```

### MySQL Backup

```bash
npm run dev:mysql-tool
```

Open:

```text
http://localhost:5174
```

API health:

```text
http://localhost:8788/api/health
```

Production-style:

```bash
npm run build:mysql-tool
npm run start:mysql-tool
```

### MySQL-to-PostgreSQL Migration

```bash
npm run dev:mysql-pg-migrate
```

Open:

```text
http://localhost:5175
```

API health:

```text
http://localhost:8789/api/health
```

Production-style:

```bash
npm run build:mysql-pg-migrate
npm run start:mysql-pg-migrate
```

Run the current test suite:

```bash
npm --prefix ./mysql-pg-migrate test
```

## API Mount Paths

Each tool can run standalone or inside the shared host.

Standalone API base paths:

```text
pg-backup:         /api
mysql-tool:        /api
mysql-pg-migrate:  /api
```

Shared-host API base paths:

```text
pg-backup:         /api/tools/pg-backup
mysql-tool:        /api/tools/mysql-tool
mysql-pg-migrate:  /api/tools/mysql-pg-migrate
```

Example:

```text
Standalone pg-backup health:
http://localhost:8787/api/health

Shared-host pg-backup health:
http://localhost:8787/api/tools/pg-backup/health
```

## PostgreSQL Backup Usage

Use `pg-backup` when you want local PostgreSQL backup artifacts from `pg_dump`, `psql`, and optionally `pg_dumpall`.

### Basic workflow

1. Start the tool.
2. Open the `Run` tab.
3. Choose a connection method:
   - full PostgreSQL connection string
   - host/port/user/database/password fields
4. Click `Test connection`.
5. Choose backup artifacts.
6. Optionally set schema/table include or exclude filters.
7. Click `Run backup`.
8. Watch logs and progress.
9. Download the zip when the job is done.

### Artifacts

Depending on selected options, a run can produce:

- `db.dump`: custom-format PostgreSQL dump
- `schema.sql`: schema-only dump
- `db.sql`: plain SQL dump
- `inventory/*.csv`: extensions, policies, table list, sizes
- `globals.sql`: roles and privileges through `pg_dumpall`
- `meta.json`: run metadata
- `<timestamp>.zip`: zipped backup

### Files

Generated output lives under:

```text
pg-backup/backups/
```

Schema snapshots are stored under:

```text
pg-backup/backups/schema-snapshots/
```

Profiles are browser-local by default. The optional fallback template file is:

```text
pg-backup/pgbackup.profiles.json
```

Profile data should not contain passwords.

### Schema tab

The PostgreSQL backup tool also has a schema view. Use it to:

- load schema metadata from the active connection
- inspect tables, columns, indexes, and relationships
- save schema snapshots
- work from a pasted snapshot JSON if needed

## MySQL Backup Usage

Use `mysql-tool` when you want local MySQL backup artifacts from `mysqldump` and `mysql`.

### Basic workflow

1. Start the tool.
2. Open the `Run` tab.
3. Enter host, port, user, password, database, and SSL mode.
4. Click `Test connection`.
5. Choose backup artifacts.
6. Optionally set table include or exclude filters.
7. Click `Run backup`.
8. Watch logs and progress.
9. Download the zip when the job is done.

### Connection strings and SSL

The MySQL backup UI accepts a `mysql://` connection string. Values from the URL are used at runtime when explicit fields are missing.

For MySQL CLI backups, `SSL CA path`, `SSL cert path`, and `SSL key path` are passed to `mysql`/`mysqldump` as file-path options.

### Artifacts

Depending on selected options, a run can produce:

- `db.sql`: full SQL dump
- `schema.sql`: schema-only dump
- `inventory/*.tsv`: metadata exports
- `meta.json`: run metadata
- `<timestamp>.zip`: zipped backup

### Files

Generated output lives under:

```text
mysql-tool/backups/
```

Profiles are browser-local by default. The optional fallback template file is:

```text
mysql-tool/mysqltool.profiles.json
```

Profile data should not contain passwords.

## MySQL-to-PostgreSQL Migration Usage

Use `mysql-pg-migrate` when you want to plan, validate, provision, and execute a MySQL-to-PostgreSQL data migration.

This tool is a workbench. It can move real data, but you should test against staging databases before using it for production cutover.

### Workflow

1. Open the `Workspace` tab.
2. Enter a project name.
3. Enter source MySQL connection details.
4. Enter target PostgreSQL connection details.
5. Load source schemas.
6. Load target schemas.
7. Select the source MySQL database/schema.
8. Select the target PostgreSQL schema.
9. Introspect schemas.
10. Save the project.
11. Open the `Mapping` tab.
12. Add table mappings.
13. Add column mappings.
14. Configure transforms, write mode, conflict keys, and load strategy.
15. Save mappings.
16. Open `Validate & Run`.
17. Run verification.
18. Run transform preview.
19. Build dry run.
20. Execute the migration.
21. Watch run logs, reports, checkpoints, watermarks, and errors.

### Core concepts

Table mapping:

- source MySQL table
- target PostgreSQL table
- existing target or create-new target
- write mode
- conflict keys
- chunk size
- load strategy

Column mapping:

- source column
- target column
- existing target, create-new target, or ignore
- transform rule
- optional notes

Write modes:

- `append`: insert rows without deduplication
- `truncate`: truncate the target table first, then load
- `upsert`: insert or update using conflict keys

Load strategies:

- `historical_full`: load all source rows
- `historical_filtered`: load rows matching a configured filter
- `incremental_watermark`: load rows newer than the saved watermark
- `historical_then_incremental`: first historical, later incremental once a watermark exists

Error policies:

- `fail-fast`: stop on first serious failure
- `quarantine`: continue and store failed row details for review/replay

### Migration state

Server-side migration state is stored as JSON under:

```text
mysql-pg-migrate/state/
```

Important subdirectories:

```text
projects/       saved migration projects and mappings
runs/           run records
checkpoints/    per-table progress checkpoints
reports/        preflight, transform-preview, dry-run, replay reports
errors/         captured row or table errors
replays/        replay attempts
watermarks/     persisted incremental watermarks
```

This directory is ignored by git, but it can contain schema metadata, run metadata, failed row payloads, and report summaries. Treat it as sensitive local data.

### Credential handling

Server-side saved migration projects remove database passwords before writing project files.

The browser workspace now strips passwords, private SSL keys, and full connection strings before saving workspace state in `localStorage`. Use `Clear local credentials` in the migration workspace toolbar after sensitive work on a shared machine.

### Connection-string note

Target PostgreSQL connection strings are used by the migration backend.

The source MySQL `connectionString` field accepts `mysql://` or `mysql2://` URLs. Values from the URL satisfy host, port, user, password, database, SSL mode, and optional SSL material when explicit fields are missing.

## Main API Endpoints

These examples use standalone base paths. Prefix them with `/api/tools/<tool-id>` when using the shared host.

### Backup tools

`pg-backup` and `mysql-tool` expose similar job APIs:

```text
GET  /api/health
GET  /api/profiles-template
POST /api/test-connection
POST /api/backup
GET  /api/jobs
GET  /api/jobs/:id
GET  /api/jobs/:id/events
GET  /api/jobs/:id/download
POST /api/jobs/:id/cancel
POST /api/jobs/:id/delete
POST /api/cleanup
```

`pg-backup` also exposes:

```text
POST /api/schema/snapshot
POST /api/schema/list-schemas
```

### Migration tool

```text
GET  /api/health
GET  /api/transforms/catalog
POST /api/connections/source/schemas
POST /api/connections/target/schemas
POST /api/introspect
GET  /api/projects
POST /api/projects
GET  /api/projects/:id
PUT  /api/projects/:id
POST /api/projects/:id/preflight
POST /api/projects/:id/schema-plan
POST /api/projects/:id/provision-target
POST /api/projects/:id/verify
POST /api/projects/:id/transform-preview
POST /api/projects/:id/dry-run
POST /api/projects/:id/execute
GET  /api/projects/:id/export
POST /api/projects/import
GET  /api/projects/:id/watermarks
PUT  /api/projects/:id/watermarks/:tableName
DELETE /api/projects/:id/watermarks/:tableName
GET  /api/runs
GET  /api/runs/:id
POST /api/runs/:id/resume
POST /api/runs/:id/rerun-failed
GET  /api/runs/:id/report
POST /api/runs/:id/report
GET  /api/runs/:id/events
GET  /api/runs/:id/errors
GET  /api/runs/:id/errors/export
POST /api/runs/:id/replay-errors
POST /api/runs/:id/replay-import
GET  /api/runs/:id/replays
GET  /api/runs/:id/cutover-readiness
POST /api/runs/:id/cutover-readiness
```

## Data And Generated Files

Gitignored generated data:

```text
**/backups/
mysql-pg-migrate/state
public/assets/*
**/public/assets/*
```

Do not commit:

- database dumps
- backup zips
- migration state
- dry-run reports with sample data
- error exports
- local credential material

## Safety Model

These tools are intended to run on a trusted developer machine.

Important caveats:

- Express servers bind to `127.0.0.1` by default.
- If you set `HOST` to a non-loopback address, set `TOOLS_AUTH_TOKEN`; servers refuse non-loopback binds without it.
- Open token-protected UIs with `?token=<value>` once so API calls and live streams include the token.
- Backup tools invoke local database CLI binaries.
- Database credentials are passed to subprocesses through environment variables where the database CLI requires them.
- Migration dry-run and transform-preview report files redact sample row payloads when persisted; live UI responses still show preview samples.
- Error exports and quarantine files can contain source row payloads.

Example non-loopback run:

```bash
HOST=0.0.0.0 TOOLS_AUTH_TOKEN="$(openssl rand -hex 24)" npm run start
```

Then open the UI with `?token=<the-token>` in the URL.

Recommended operating practices:

- Run only on a trusted workstation.
- Do not expose these ports through tunnels, reverse proxies, or shared networks.
- Prefer staging databases for testing.
- Clear browser storage and generated state after sensitive work.
- Keep generated backup and migration state directories out of git.

## Troubleshooting

### `UI not built`

You started a production-style server before building its UI.

Fix:

```bash
npm run build
npm run start
```

For standalone tools, use the matching tool scripts, such as:

```bash
npm run build:pg-backup
npm run start:pg-backup
```

### API works standalone but 404s in shared host

Use the right base path.

Standalone:

```text
/api/health
```

Shared host:

```text
/api/tools/<tool-id>/health
```

### `pg_dump` or `psql` not found

Install PostgreSQL client tools or set:

```bash
export PG_DUMP_PATH="/absolute/path/to/pg_dump"
export PSQL_PATH="/absolute/path/to/psql"
```

### `mysql` or `mysqldump` not found

Install MySQL client tools or set:

```bash
export MYSQL_PATH="/absolute/path/to/mysql"
export MYSQLDUMP_PATH="/absolute/path/to/mysqldump"
```

### Root scripts fail because Vite or concurrently is missing

Install `pg-backup` dependencies:

```bash
npm --prefix ./pg-backup install
```

Current scripts resolve Vite and concurrently through `src/runPackageBin.js`. If a binary cannot be resolved, install dependencies from the repository root and the relevant subtool.

### Migration says source password is required

The migration backend accepts the explicit MySQL password field or a password embedded in a `mysql://` source connection string. If the error persists, verify the URL is valid and includes a username, password, host, and database.

### Execution says verification or transform preview is stale

Run the current sequence again:

```text
Verify project
Transform preview
Build dry run
Execute migration
```

Changing mappings, transforms, source/target catalogs, selected tables, or load phase can invalidate prior verification/preview fingerprints.

### Backup history disappeared after restart

Backup job metadata is persisted under each tool's `backups/.jobs` directory and rehydrated on startup. Existing timestamped folders/zips are also listed as artifact jobs when no metadata file exists.

## Development Notes

Useful commands:

```bash
npm run dev
npm run build
npm run start
npm --prefix ./mysql-pg-migrate test
```

Before changing migration behavior, add or update tests under:

```text
mysql-pg-migrate/test/
```

Before changing backup runners, test with a disposable database and verify:

- connection test
- successful backup
- zip download
- cancellation
- cleanup
- missing-tool error path

Before exposing these tools beyond a local machine, review the residual hardening notes in [IMPLEMENTATION_GAPS.md](./IMPLEMENTATION_GAPS.md).
