# mysql-pg-migrate usage guide

This guide explains how to use the MySQL → PostgreSQL migration workbench after the latest workflow updates.

The most important idea is:

> The tool can inspect schemas and suggest mappings, but **you define migration intent**.

Use suggestions only as a starting point. Review table mappings, column mappings, write mode, conflict keys, and load strategy before running anything against real data.

---

## 1. Start the tool

From the tools repo root:

```bash
npm --prefix ./mysql-pg-migrate run dev
```

Or from anywhere on this machine:

```bash
npm --prefix /Users/ramakanth/pers/website/tools/mysql-pg-migrate run dev
```

Open:

```text
http://localhost:5175
```

Production-style run:

```bash
npm --prefix /Users/ramakanth/pers/website/tools/mysql-pg-migrate run build
npm --prefix /Users/ramakanth/pers/website/tools/mysql-pg-migrate run start
```

---

## 2. Terminology: MySQL vs PostgreSQL

### MySQL

In MySQL, **database** and **schema** are effectively the same thing.

Example:

```text
MySQL database/schema: shop_mysql
Table: t1
Full table name: shop_mysql.t1
```

There is no nested schema inside `shop_mysql` like PostgreSQL has.

### PostgreSQL / Supabase

PostgreSQL has schemas inside a database.

Example:

```text
PostgreSQL database: postgres / Supabase DB
Schema: public
Table: t2
Full table name: public.t2
```

In the UI:

```text
Source MySQL Database / Schema = your MySQL database name
Target PostgreSQL Schema       = usually public
```

---

## 3. Recommended migration workflow

Use this sequence:

```text
Workspace
  -> enter connections
  -> load schemas
  -> preview/introspect schemas
  -> save manual mapping project

Mapping
  -> map source tables to target tables
  -> map source columns to target columns
  -> configure write mode, conflict keys, and load strategy
  -> save project

Validate & Run
  -> verify project
  -> build dry run
  -> choose run mode/load phase
  -> execute
  -> inspect report/history/errors/watermarks
```

---

## 4. Workspace tab

Workspace is for connecting to databases and creating a migration project.

### Steps

1. Enter a **Project name**.
2. Fill **Source MySQL** connection details.
3. Fill **Target PostgreSQL / Supabase** connection details.
4. Click **Load schemas** under MySQL.
5. Select the MySQL database/schema.
6. Click **Load schemas** under PostgreSQL.
7. Select PostgreSQL schema, usually `public`.
8. Click **Preview / introspect schemas**.
9. Choose one project creation action:
   - **Save manual mapping project** — recommended for explicit manual mapping.
   - **Create project with suggested mappings** — creates name/type guesses as a starting point.

### Important

`Preview / introspect schemas` does not by itself create a project. It only reads and previews the source/target catalogs.

To see a project in the Mapping tab, click one of:

- **Save manual mapping project**
- **Create project with suggested mappings**

---

## 5. Mapping tab

Mapping is where you define what should move where.

### Load a project

At the top of the Mapping tab:

1. Select your project from the project dropdown.
2. If needed, click **Refresh** in History or reload the app.

### Add a table mapping

Use **Add manual table mapping**:

1. Select **Source table** from dropdown.
2. Choose **Target table mode**:
   - `use existing`
   - `create new`
3. If using existing target table, select target table from dropdown.
4. If creating a new table, type the new target table name.
5. Click **Add mapping**.

Typing is only needed for new target tables. Existing source/target tables use dropdowns.

---

## 6. Write modes

Each table mapping has a write mode.

### append

Adds rows to the target table.

Use when:

- target table is empty, or
- duplicates are impossible due to target constraints, or
- you are intentionally appending new data.

Risk:

- reruns can duplicate rows.

### truncate

Truncates target table before loading.

Use when:

- you want a clean full reload.

Risk:

- destructive to target table contents.

### upsert

Inserts or updates based on conflict keys.

Use when:

- you want retry-safe loads,
- target already has some rows,
- you want incremental update-safe loads.

Requires:

- valid conflict keys matching a target primary key or unique key.

---

## 7. Conflict keys

Conflict keys tell PostgreSQL how to identify the same row during upsert.

Example:

```text
id
```

or:

```text
external_id
```

For upsert, conflict keys must match a real primary key or unique key on the target PostgreSQL table.

---

## 8. Column mapping

For each table mapping:

1. Click **Add column mapping**, or
2. Click **Add all source columns**.

For each column row:

1. Choose **Source column** from dropdown.
2. Choose target column mode:
   - `existing target column`
   - `create new target column`
   - `ignore / unmapped`
3. Select target column from dropdown, or type a new column name.
4. Choose transform if needed.
5. Save project.

### Target column modes

#### existing target column

Writes source values into an existing PostgreSQL column.

#### create new target column

Plans/provisions a new PostgreSQL column.

#### ignore / unmapped

Does not migrate that source column.

Ignored columns should not block preflight.

---

## 9. Transforms

Column transforms allow simple conversion before writing.

Common options:

- `direct`
- `string`
- `number`
- `boolean`
- `json`
- `date`
- `datetime`
- `constant`
- `null`
- `template`
- `lookup`
- `expression`
- `concat`
- `coalesce`

Use transforms when source and target types or shape differ.

Example cases:

- MySQL `tinyint(1)` → PostgreSQL `boolean`
- string JSON → PostgreSQL `jsonb`
- `first_name` + `last_name` → `display_name`

---

## 10. Load strategy per table

Every table can use its own strategy.

### historical full load

Loads all rows from the source table.

Best for:

- one-time full migration
- target reloads

Common write modes:

- `truncate`
- `append`
- `upsert`

### historical filtered load

Loads only rows matching a filter.

Examples:

```text
created_at >= 2020-01-01
id between 1000 and 5000
status = active
```

Configure:

- filter column
- operator
- value
- optional end value for `between`

### incremental watermark load

Loads only rows newer than the last saved watermark.

Best for:

- repeated sync runs
- catch-up loads
- update-safe migration when source has `updated_at`

Requires:

- watermark column, usually `updated_at`
- tie-breaker column, usually `id`
- preferably write mode `upsert`
- valid conflict keys

### historical + then incremental

Recommended for real migrations.

First run:

```text
historical full or filtered load
```

Later runs:

```text
incremental watermark load
```

The tool decides based on whether a persisted watermark exists for that table.

---

## 11. Incremental watermarks

The tool persists table-level watermarks under local state.

Conceptually:

```json
{
  "projectId": "project_xxx",
  "tables": {
    "songs": {
      "watermarkColumn": "updated_at",
      "tieBreakerColumn": "id",
      "lastWatermark": "2026-06-18T00:00:00.000Z",
      "lastTieBreaker": 9182
    }
  }
}
```

### Set baseline

Use **Set baseline** if you want incremental to begin from a known value.

Example:

```text
2026-06-01T00:00:00.000Z
```

### Reset watermark

Use **Reset** if you want the table to start again from its configured baseline or from the beginning.

### Lookback window

Lookback reruns a small overlap period.

Example:

```text
lookback amount: 5
lookback unit: minutes
```

This helps catch late-arriving updates.

---

## 12. Delete handling

Watermark incremental loading does **not** detect hard deletes.

If rows are physically deleted in MySQL, the tool will not know from `updated_at` alone.

Options:

### none

No delete handling. Use this if deletes are irrelevant or manually reconciled.

### soft-delete column

Use this if source has a column such as:

```text
deleted_at
is_deleted
status
```

Map that column to target and handle deletion state in your application or downstream process.

---

## 13. Validate & Run tab

Use this tab to verify and run migrations.

### Recommended sequence

1. Click **Verify project**.
2. Fix blockers in Mapping.
3. Click **Run preflight** for detailed report.
4. Click **Build dry run**.
5. Choose execution options.
6. Click **Execute migration**.

### Run mode

- `all`: all enabled table mappings.
- `selected`: only selected tables from dropdown.

### Load phase

- `configured per table`: uses each table’s load strategy.
- `force historical`: runs historical mode.
- `force incremental`: runs incremental mode.

### Error policy

- `fail-fast`: stop on first serious error.
- `quarantine`: continue and store bad rows/errors.

### Dry run checkbox

Marks execution as dry run / preview mode where applicable.

For safer previewing, also use **Build dry run** before execution.

---

## 14. Common workflows

### A. One-time full migration

```text
Workspace
  -> load schemas
  -> preview/introspect
  -> save manual mapping project

Mapping
  -> map tables
  -> map columns
  -> strategy = historical full load
  -> write mode = truncate or append
  -> save project

Validate & Run
  -> verify project
  -> build dry run
  -> execute
```

### B. Full reload into existing target

```text
Mapping
  -> strategy = historical full load
  -> write mode = truncate
  -> save project

Validate & Run
  -> verify
  -> execute
```

### C. Historical then incremental migration

```text
Mapping
  -> strategy = historical + then incremental
  -> watermark column = updated_at
  -> tie-breaker column = id
  -> write mode = upsert
  -> conflict keys = id
  -> save project

Validate & Run
  -> verify
  -> execute with load phase = configured per table
  -> later execute again with configured per table
```

First execution loads history. Later executions use the saved watermark.

### D. Filtered historical load

```text
Mapping
  -> strategy = historical filtered load
  -> filter column = created_at
  -> operator = >=
  -> value = 2020-01-01
  -> save project

Validate & Run
  -> verify
  -> build dry run
  -> execute
```

### E. Selected incremental catch-up

```text
Validate & Run
  -> run mode = selected
  -> choose tables
  -> load phase = force incremental
  -> execute
```

---

## 15. Verification blockers you may see

### no_enabled_table_mappings

You have not enabled/created any active table mappings.

Fix:

- Add at least one table mapping.

### no_enabled_column_mappings

Table has no active source → target column mappings.

Fix:

- Add at least one column mapping.

### missing_target_table

Target table does not exist and mapping is not set to create new.

Fix:

- choose an existing target table, or
- choose create new.

### missing_target_column

Mapped target column does not exist.

Fix:

- choose an existing target column, or
- mark as create new, or
- ignore the source column.

### missing_conflict_keys

Write mode is upsert but no conflict keys are configured.

Fix:

- select target primary key / unique key columns.

### invalid_conflict_keys

Selected conflict keys do not match a PostgreSQL primary key or unique key.

Fix:

- choose correct unique/primary key columns,
- or add a unique constraint in PostgreSQL.

### missing_incremental_watermark_column

Incremental strategy needs a valid watermark column.

Fix:

- choose `updated_at`, `created_at`, or another stable source column.

### missing_incremental_tie_breaker_column

Incremental strategy needs a stable tie-breaker.

Fix:

- choose primary key such as `id`.

---

## 16. Safety checklist

Before real migration:

- [ ] Use staging first.
- [ ] Backup target database/table.
- [ ] Review every table mapping.
- [ ] Review every column mapping.
- [ ] Verify project.
- [ ] Build dry run.
- [ ] Use upsert for incremental update-safe loads.
- [ ] Set valid conflict keys.
- [ ] Avoid append unless duplicate risk is acceptable.
- [ ] Confirm hard-delete handling expectations.

---

## 17. Current limitations

This tool is now a practical migration workbench, but still not a full enterprise CDC platform.

Current limitations:

- no true MySQL binlog CDC
- hard deletes are not automatically captured by watermark mode
- reconciliation is still mostly row-count/report based
- no full checksum/hash validation yet
- schema provisioning is not full schema migration parity
- triggers/functions/policies/procedures are not migrated
- watermark baseline editing UI is functional but basic
- rejected-row repair UI is still basic

---

## 18. Recommended operating model

For serious migration:

1. Create project from staging databases.
2. Define manual mappings.
3. Run historical load to staging target.
4. Verify row counts and sample records manually.
5. Configure incremental watermark strategy.
6. Run incremental catch-up repeatedly.
7. Freeze writes or use app maintenance window.
8. Run final incremental catch-up.
9. Verify again.
10. Cut over application to PostgreSQL/Supabase.

---

## 19. Where state is stored

Local tool state is stored under:

```text
mysql-pg-migrate/state/
```

Important folders:

```text
state/projects      saved projects and mappings
state/runs          run history
state/reports       preflight / dry-run reports
state/checkpoints   per-run checkpoint progress
state/errors        rejected/error records
state/replays       replay records
state/watermarks    project/table incremental watermark state
```

---

## 20. Quick start summary

If you only remember one path, use this:

```text
Workspace
  1. Enter project name
  2. Enter MySQL + PostgreSQL credentials
  3. Load schemas
  4. Preview / introspect schemas
  5. Save manual mapping project

Mapping
  6. Add source table → target table mapping
  7. Add source column → target column mappings
  8. Pick write mode
  9. Pick load strategy
  10. Save project

Validate & Run
  11. Verify project
  12. Build dry run
  13. Execute migration
  14. Inspect report/history/watermarks
```
