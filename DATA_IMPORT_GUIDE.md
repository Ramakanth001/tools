# MySQL → PostgreSQL Data Import Guide

> A **beginner-friendly**, end-to-end guide for importing data from a MySQL source into a PostgreSQL target using the **mysql-pg-migrate** workbench tool.

---

## Table of Contents

1. [Overview — What This Tool Does](#1-overview--what-this-tool-does)
2. [Prerequisites](#2-prerequisites)
3. [Getting Your MySQL Dump Ready](#3-getting-your-mysql-dump-ready)
4. [Starting the Tool](#4-starting-the-tool)
5. [Step 1 — Workspace: Connect & Introspect](#5-step-1--workspace-connect--introspect)
6. [Step 2 — Mapping: Tables, Columns & Load Strategy](#6-step-2--mapping-tables-columns--load-strategy)
7. [Step 3 — Transform: Filters, Rewrites & Mojibake Repair](#7-step-3--transform-filters-rewrites--mojibake-repair)
8. [Step 4 — Validate & Run: Verify, Dry Run, Execute](#8-step-4--validate--run-verify-dry-run-execute)
9. [Post-Run: Reports, Errors & Replay](#9-post-run-reports-errors--replay)
10. [Incremental Data Loads (Detailed)](#10-incremental-data-loads-detailed)
11. [Mojibake Repair (Detailed)](#11-mojibake-repair-detailed)
12. [Complete Options Reference](#12-complete-options-reference)
13. [Common Scenarios & Recipes](#13-common-scenarios--recipes)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Overview — What This Tool Does

This tool migrates data from a **MySQL database** to a **PostgreSQL database** (including Supabase) through a browser-based UI. It handles:

- **Schema introspection** — reads both databases and shows you all tables & columns
- **Manual mapping** — you decide which MySQL tables → PostgreSQL tables, which columns → columns
- **Data transforms** — clean, rewrite, or fix values during migration (including mojibake/encoding repair)
- **Filtered & incremental loads** — migrate only specific rows (e.g., `dcid > 5785`) or only new rows since the last run
- **Verification & dry run** — validate everything before touching real data
- **Execution** — actually write the data into PostgreSQL
- **Error recovery** — inspect errors, export, correct, and replay failed rows

### Key Concept

> **You define migration intent.** The tool helps you inspect schemas and preview data, but **you** decide what gets mapped where, what gets transformed, and what load strategy to use.

---

## 2. Prerequisites

Before you start, make sure you have:

| Requirement | Details |
|---|---|
| **Node.js** | v18+ installed |
| **MySQL database** | Running and accessible (local XAMPP, remote server, cloud) |
| **PostgreSQL database** | Running and accessible (local, Supabase, cloud) |
| **MySQL credentials** | Host, port, user, password, database name |
| **PostgreSQL credentials** | Connection string or host/port/user/password/database |
| **SQL dump imported** | Your `.sql` dump file already imported into the MySQL database |

---

## 3. Getting Your MySQL Dump Ready

If you have a `.sql` dump file, you need to import it into MySQL first. The tool reads from a **live MySQL server**, not from `.sql` files directly.

### Option A: Import via XAMPP/phpMyAdmin

1. Open phpMyAdmin → `http://localhost/phpmyadmin`
2. Create a new database (e.g., `mydata`)
3. Select the database → click **Import** tab
4. Choose your `.sql` file → click **Go**

### Option B: Import via MySQL command line

```bash
mysql -u root -p mydata < /path/to/dump.sql
```

### Option C: Import via MySQL Workbench

1. Open MySQL Workbench → connect to your server
2. Server → Data Import → Import from Self-Contained File
3. Select your `.sql` file → Start Import

Once imported, your data is in a live MySQL database and ready for the tool.

---

## 4. Starting the Tool

From the tools repository root:

```bash
npm run dev:all
```

Or specifically for the migration tool:

```bash
npm --prefix ./mysql-pg-migrate run dev
```

Open in your browser:

```
http://localhost:5175
```

The UI has **4 tabs** across the top, representing the 4 steps:

```
┌─────────────┬──────────┬─────────────┬──────────────────┐
│  Workspace  │ Mapping  │  Transform  │ Validate & Run   │
│  (Step 1)   │ (Step 2) │  (Step 3)   │    (Step 4)      │
└─────────────┴──────────┴─────────────┴──────────────────┘
```

---

## 5. Step 1 — Workspace: Connect & Introspect

This is where you connect to both databases and create a migration project.

### 5.1 Enter Source MySQL Connection

| Field | What to Enter | Example |
|---|---|---|
| **Host** | MySQL server hostname | `localhost` or `127.0.0.1` |
| **Port** | MySQL port | `3306` |
| **User** | MySQL username | `root` |
| **Database** | MySQL database name | `mydata` |
| **Password** | Your MySQL password | *(entered at runtime)* |
| **SSL mode** | SSL connection type | `DISABLED` for local/XAMPP |

> **Tip for XAMPP/local MySQL:** Set SSL mode to `DISABLED` unless your server explicitly requires SSL.

### 5.2 Enter Target PostgreSQL Connection

You can connect via **connection string** or **pooler fields**.

#### Option A: Connection String (easiest for Supabase)

Paste the full connection string from your Supabase dashboard:

```
postgresql://postgres.abc123:password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
```

#### Option B: Pooler Fields (manual)

| Field | What to Enter | Example |
|---|---|---|
| **Host** | PostgreSQL hostname | `db.xyz.supabase.co` |
| **Port** | PostgreSQL port | `5432` or `6543` |
| **User** | PostgreSQL username | `postgres` |
| **Database** | PostgreSQL database | `postgres` |
| **Password** | PostgreSQL password | *(entered at runtime)* |
| **SSL mode** | SSL type | `require` for Supabase |

### 5.3 Load & Select Schemas

1. Click **Load schemas** under Source MySQL → select your MySQL database/schema
2. Click **Load schemas** under Target PostgreSQL → select your target schema (usually `public`)

### 5.4 Introspect & Create Project

1. Enter a **Project name** (e.g., "my-data-migration")
2. Click **Preview / introspect schemas** — this reads all tables and columns from both databases
3. Click **Save & open Mapping** — this creates the project and moves you to Step 2

> **Important:** Introspecting does NOT create a project by itself. You must click **Save & open Mapping** (or **Save project**) to persist it.

### 5.5 Understanding Schema Terminology

| MySQL | PostgreSQL |
|---|---|
| `database` = `schema` (same thing) | `database` contains multiple `schemas` |
| Tables live directly under the database | Tables live under a schema (usually `public`) |
| `mydata.users` | `public.users` |

---

## 6. Step 2 — Mapping: Tables, Columns & Load Strategy

This is the core step where you define **what goes where**.

### 6.1 Add a Table Mapping

Under **"Add manual table mapping"**:

1. **Source table** — select from dropdown (your MySQL table)
2. **Target table mode** — choose:
   - `use existing` — map to an existing PostgreSQL table
   - `create new` — create a brand new PostgreSQL table
3. **Target table** — select from dropdown (existing) or type a name (new)
4. Click **Add mapping**

> You can add multiple table mappings to migrate several tables in one project.

### 6.2 Map Columns

For each table mapping, you need to map columns:

1. Click **Add all source columns** (maps everything at once), or
2. Click **Add column mapping** (add one at a time)

For each column:

| Setting | Options | What It Means |
|---|---|---|
| **Use** (checkbox) | ☑ or ☐ | Enable/disable this column |
| **Source column** | Dropdown | Which MySQL column to read from |
| **Target column mode** | `existing target column` | Map to an existing PG column |
|  | `create new target column` | Create a new PG column |
|  | `ignore / unmapped` | Skip this column entirely |
| **Target column** | Dropdown or text | Which PG column to write to |
| **Transform** | Badge | Shows current transform (configure in Step 3) |

### 6.3 Load Strategy & Write Options

Each table mapping has a **"Load strategy & write options"** card with many important settings:

#### Write Mode

| Mode | What It Does | When to Use |
|---|---|---|
| **append** | Inserts rows into target table | Target is empty, or you're adding new rows |
| **truncate** | Deletes all target rows, then loads | You want a clean full reload every time |
| **upsert** | Inserts new rows, updates existing ones | Retry-safe, incremental, or update-safe loads |

> ⚠️ **Append** can create duplicate rows if you run the migration again. Use **upsert** for retry safety.

#### Conflict Strategy

| Strategy | What It Does |
|---|---|
| **insert** | Simple insert; fails on duplicate primary keys |
| **upsert** | Insert or update based on conflict keys |
| **truncate-load** | Delete all rows first, then insert |

#### Conflict Keys

Select the PostgreSQL column(s) that form a **primary key or unique constraint**. Required for upsert.

Example: If your target table has `PRIMARY KEY (id)`, select `id` as the conflict key.

> Hold **Ctrl** (Windows) or **Cmd** (Mac) to select multiple conflict key columns.

#### Chunk Size

How many rows to insert at a time. Default: `500`. Increase for faster loads on large tables; decrease if you get memory issues.

#### Strategy (Load Strategy)

This is the most important setting for controlling **which rows** get migrated:

| Strategy | What It Does | When to Use |
|---|---|---|
| **historical full load** | Migrates ALL rows from the source table | First-time full migration |
| **historical filtered load** | Migrates only rows matching a filter | Partial migration (e.g., `dcid > 5785`) |
| **incremental watermark load** | Migrates only rows newer than the last watermark | Ongoing sync — only new/changed rows |
| **historical + then incremental** | First run does historical (full or filtered), subsequent runs do incremental | Best of both — full initial load then ongoing sync |

#### Historical Filter (only for filtered/historical-then-incremental strategies)

| Setting | What to Choose | Example |
|---|---|---|
| **Historical filter** | `enabled` | — |
| **Filter column** | The source column to filter on | `dcid` |
| **Filter operator** | Comparison operator | `>`, `>=`, `<`, `<=`, `=`, `!=`, `between`, `like`, `is null`, `is not null` |
| **Filter value** | The threshold value | `5785` |
| **Filter end value** | Only for `between` operator | `10000` |

**Example:** To migrate only rows where `dcid > 5785`:

```
Strategy:          historical filtered load
Historical filter: enabled
Filter column:     dcid
Filter operator:   >
Filter value:      5785
```

This adds `WHERE dcid > 5785` to the source MySQL query.

#### Watermark Column (only for incremental/historical-then-incremental)

Select the source column that tracks row insertion/update order. Common choices:
- `id` (auto-increment primary key)
- `updated_at` (timestamp)
- `created_at` (timestamp)

#### Tie-Breaker Column

A secondary sort column for when watermark values are identical. Usually the primary key.

#### Lookback Amount & Unit

For incremental loads, optionally look back a small window to catch late-arriving updates:
- Amount: `5`
- Unit: `minutes` / `hours` / `days`

#### Persist Watermark

When checked (default), the tool saves the highest watermark value after a successful load. Next incremental run starts from there.

#### Delete Handling

| Mode | What It Does |
|---|---|
| **none** | Hard deletes in MySQL are NOT captured |
| **soft-delete column** | Uses a source column (e.g., `deleted_at`) to track deletions |

#### Create Target Table

If checked, the tool will auto-create the PostgreSQL table if it doesn't exist.

### 6.4 Target Schema Provisioning

At the bottom of the Mapping tab, you can:

1. **Generate schema plan** — see what tables/columns need to be created in PostgreSQL
2. **Provision target tables** — actually create missing tables and columns

### 6.5 Save Your Work

- Click **Save mappings** to persist your configuration
- Click **Save & continue to Transform** to move to Step 3

---

## 7. Step 3 — Transform: Filters, Rewrites & Mojibake Repair

The Transform tab lets you modify data values as they move from MySQL to PostgreSQL.

### 7.1 Row Filters

For each table mapping, you can enable a **row filter** that drops rows based on a JavaScript expression:

| Setting | Example |
|---|---|
| **Enable row filter** | ☑ |
| **Expression** | `row.status !== 'deleted'` |
| **Required columns** | `status, deleted_at` |

The expression receives each source row as `row` and should return `true` to keep the row.

More examples:
```javascript
row.active === 1                          // only active rows
row.email && row.email.includes('@')      // only rows with valid email
Number(row.age) >= 18                     // only adult rows
```

### 7.2 Column Transforms

For each column mapping, you can select a transform type from the dropdown:

| Transform Type | What It Does | Config Needed |
|---|---|---|
| **direct** | Pass value as-is (no change) | None |
| **string** | Cast to string | None |
| **number** | Cast to number | None |
| **boolean** | Convert boolean-like values (1/0, "yes"/"no") | None |
| **json** | Parse JSON string into object | None |
| **date** | Parse as date | None |
| **datetime** | Parse as datetime | None |
| **constant** | Always write a fixed value | The constant value |
| **null** | Always write NULL | None |
| **template** | Build value from multiple columns | Template string: `{{first_name}} {{last_name}}` |
| **lookup** | Replace values using a map | Key-value pairs (e.g., `1=Y`, `0=N`) |
| **lookup_table** | Join with another source table | Table name, local key, lookup key, value column |
| **expression** | Custom JavaScript expression | JS expression: `value === '1' ? 'Y' : 'N'` |
| **concat** | Combine multiple columns | Field names + delimiter |
| **coalesce** | Use first non-null value from multiple columns | Field names |
| **conditional** | Branch logic (if/then/else) | JSON config with branches |
| **mojibake_repair** | Fix Unicode encoding corruption | Mode: auto, force, or detect_only |

#### Expression Examples

```javascript
// Convert MySQL boolean (1/0) to text
value === 1 ? 'active' : 'inactive'

// Trim and lowercase email
value == null ? null : String(value).trim().toLowerCase()

// Extract year from date string
value ? String(value).substring(0, 4) : null

// Combine multiple source columns (use row.columnName)
`${row.first_name || ''} ${row.last_name || ''}`.trim()
```

#### Lookup Example

Map MySQL enum values to PostgreSQL-friendly values:

```
1=active
2=inactive
3=pending
0=unknown
```

Default value (when no match): `unknown`

#### Lookup Table Example

Join with a reference table in MySQL to resolve IDs:

| Setting | Example |
|---|---|
| **Lookup table** | `categories` |
| **Local source column** | `category_id` |
| **Lookup key column** | `id` |
| **Lookup value column** | `name` |
| **Missing key** | `reject row` / `write null` / `use default` |

### 7.3 Transform Presets (Quick Apply)

The transform dropdown also includes **presets** — pre-configured transforms you can apply with one click:

| Preset | What It Does |
|---|---|
| `preset:trim_string` | Trim whitespace from strings |
| `preset:lower_email` | Lowercase + trim email values |
| `preset:upper_code` | Uppercase + trim code values |
| `preset:boolean_flag` | Convert boolean-like inputs |
| `preset:json_parse` | Parse JSON strings |
| `preset:full_name` | Concatenate first_name + last_name |
| `preset:keep_when_present` | Keep value if non-null/non-empty, else NULL |
| `preset:repair_unicode_mojibake` | Fix Unicode encoding corruption (auto mode) |
| `preset:repair_iast_mojibake` | Fix IAST diacritic mojibake (auto mode) |

### 7.4 Preview Transforms

1. Set **Sample rows** count (default: 5)
2. Click **Preview all transforms** — the tool fetches sample rows from MySQL and shows:
   - **sampleRows**: original data from MySQL
   - **transformedRows**: what will be written to PostgreSQL after transforms
3. Review the before/after to make sure transforms are correct
4. Click **Preview all & continue** to move to Step 4

---

## 8. Step 4 — Validate & Run: Verify, Dry Run, Execute

This is the final step before data actually moves into PostgreSQL.

### 8.1 Validation Checks

There are 3 validation buttons, each doing something different:

| Button | What It Does |
|---|---|
| **Verify project** | Checks mapping completeness, target schema readiness, conflict keys, load strategy config |
| **Run preflight** | Samples source rows, validates transforms/filters, checks for NULL violations |
| **Build dry run** | Runs Verify + Preflight + Transform Preview together; shows what WOULD be written without actually writing |

> **"Build dry run"** is the safest way to preview everything at once. It runs all checks and shows you the transformed sample data.

### 8.2 Execution Options

Before clicking **Execute migration**, configure these options:

| Option | Values | What It Means |
|---|---|---|
| **Run mode** | `all` / `selected` | Migrate all tables or only selected ones |
| **Error policy** | `fail-fast` / `quarantine` | Stop on first error, or quarantine bad rows and continue |
| **Concurrency** | `1`, `2`, `3`... | How many tables to migrate in parallel |
| **Batch size** | `1000` (default) | How many rows per insert batch |
| **CDC mode** | `off` / `snapshot-only` / `watermark` | Change data capture mode |
| **Load phase** | `configured per table` / `force historical` / `force incremental` | Override per-table load strategy |
| **Cutover mode** | `manual` / `guarded` | How cutover readiness is handled |
| **Watermark column** | Column name | Only for CDC watermark mode |
| **Selected tables** | Multi-select | Only when Run mode is `selected` |
| **Mark as dry run** | Checkbox | Run everything but don't actually write data |

#### Error Policy Explained

| Policy | Behavior |
|---|---|
| **fail-fast** | Stop the entire migration at the first error. Safest for critical data. |
| **quarantine** | Log the error, skip the bad row, continue with remaining rows. Use for large migrations where some bad rows are acceptable. |

#### CDC Mode Explained

| Mode | Behavior |
|---|---|
| **off** | No change data capture. Standard one-time load. |
| **snapshot-only** | Take a snapshot of the source at a point in time. |
| **watermark** | Use watermark columns to track and replay incremental changes. |

#### Load Phase Explained

| Phase | Behavior |
|---|---|
| **configured per table** | Each table uses its own load strategy (from Mapping tab). This is the default and recommended. |
| **force historical** | Override all tables to do a historical load (full or filtered). |
| **force incremental** | Override all tables to use incremental watermark mode. Uses saved watermarks. |

### 8.3 The Execution Gate

The **Execute migration** button stays disabled until ALL of these conditions are met:

1. ✅ At least one enabled table mapping exists
2. ✅ No unsaved mapping changes
3. ✅ Verification passed (no open blockers)
4. ✅ Transform preview completed with no errors
5. ✅ Transform scope matches the current run options
6. ✅ Execution options haven't changed since verification

If the button is disabled, look at the **"Execution gated"** message for what to fix.

### 8.4 Execute the Migration

1. Make sure all checks pass (Verify + Transform Preview)
2. Click **Execute migration**
3. Watch the live log stream — the tool shows real-time progress
4. When done, inspect the **Run report** and **History**

### 8.5 Verification Issues & Allowances

Verification can find **blockers** (must fix) and **warnings** (review):

| Issue Type | Examples |
|---|---|
| **Blockers** | Missing target table, missing conflict keys, incompatible column types, unmapped required columns |
| **Warnings** | Column type width differences, trailing-space semantics, nullable mismatches with zero null rows |

For blockers that you've reviewed and intentionally accept, you can click **Allow** and provide a reason. Allowed blockers no longer prevent execution.

---

## 9. Post-Run: Reports, Errors & Replay

### 9.1 Run History

The Validate & Run tab shows a list of all past runs. Click any run to inspect:

- **Status**: `done`, `error`, `cancelled`, `running`
- **Row counts**: inserted, updated, skipped per table
- **Errors**: what went wrong and on which rows

### 9.2 Run Report

After a run completes, click **Load run report** to see:

- Source vs target row counts per table
- Data drift or missing rows
- Verification summary

### 9.3 Error Recovery

If some rows failed:

1. Click **Export errors** — downloads a JSON file with all failed rows and their error details
2. Fix the row data offline
3. Click **Replay errors** — loads a replay plan showing which errors are replayable
4. Paste your corrected JSON into the **Replay import** textarea
5. Click **Import replay** — the tool writes corrected rows to PostgreSQL

### 9.4 Resume & Rerun

| Button | What It Does |
|---|---|
| **Resume** | Continue a paused or interrupted run from where it left off |
| **Rerun failed** | Re-execute only the tables that failed in a previous run |
| **Cancel** | Stop a running migration (finishes the current batch first) |

### 9.5 Cutover Readiness

For production migrations, click **Cutover readiness** to get a report showing:

- Whether all tables loaded successfully
- Source vs target row count comparison
- Any remaining verification issues

---

## 10. Incremental Data Loads (Detailed)

Incremental loading lets you sync only **new or changed rows** instead of reloading everything.

### 10.1 How It Works

```
First run:  Load all rows (historical full)         → watermark saved (e.g., id=5000)
Second run: Load only rows where id > 5000           → watermark updated (e.g., id=5200)
Third run:  Load only rows where id > 5200           → watermark updated (e.g., id=5350)
...and so on
```

### 10.2 Setup Steps

1. **In Mapping tab**, for your table:
   - Set **Strategy** to `incremental watermark load` or `historical + then incremental`
   - Set **Write mode** to `upsert`
   - Set **Conflict keys** to your target primary key (e.g., `id`)
   - Select **Watermark column** — the source column that grows over time (e.g., `id`, `updated_at`, `created_at`)
   - Optionally select **Tie-breaker column** — usually the primary key
   - Optionally set **Lookback amount** (e.g., `5 minutes`) to catch late-arriving updates
   - Check **Persist watermark after successful load**

2. **Save mappings**

3. **In Validate & Run tab**:
   - Set **Load phase** to `configured per table`
   - Run verification and execute

### 10.3 Strategy Comparison

| Strategy | First Run | Subsequent Runs | Best For |
|---|---|---|---|
| `historical full load` | All rows | All rows again | One-time migrations |
| `historical filtered load` | Filtered rows | Filtered rows again | Partial migrations |
| `incremental watermark load` | Rows from baseline watermark | Only new rows since last watermark | Ongoing sync (assumes baseline already loaded) |
| `historical + then incremental` | All rows (or filtered) | Only new rows since last watermark | First full load + ongoing sync |

### 10.4 Watermark Management

In the Validate & Run tab, you can manage watermarks:

- **View watermarks** — see the current saved watermark per table
- **Set baseline** — manually set the starting watermark value (useful for skipping already-loaded data)
- **Reset watermark** — clear the saved watermark (next run loads from the beginning)

### 10.5 Important Notes on Incremental Loads

| Consideration | Recommendation |
|---|---|
| **Write mode** | Always use `upsert` with valid conflict keys |
| **Hard deletes** | Watermark mode does NOT capture hard deletes. Use soft-delete columns or manual reconciliation |
| **Lookback window** | Set a small lookback (e.g., 5 min) to catch rows that were being written during the previous run |
| **Nullable watermarks** | Avoid nullable watermark columns — they cause unstable reads |
| **Duplicate risk** | Without conflict keys, incremental replays or lookback windows can duplicate rows |

---

## 11. Mojibake Repair (Detailed)

### 11.1 What Is Mojibake?

**Mojibake** is garbled text that appears when text encoded in one character encoding (like UTF-8) is read or stored using a different encoding (like Latin-1 or Windows-1252).

#### Examples of Mojibake Corruption

| What You See (Corrupted) | What It Should Be |
|---|---|
| `à°¤à±†à°²à±à°—à±` | తెలుగు (Telugu) |
| `Ä\u0081` | ā (IAST a-macron) |
| `á¹­` | ṭ (IAST retroflex t) |
| `á¹£` | ṣ (IAST retroflex s) |
| `Ã±` | ñ (Spanish n-tilde) |
| `â€™` | ' (smart quote) |
| `â€"` | — (em-dash) |
| `â€¦` | … (ellipsis) |

This commonly happens when:
- MySQL stores UTF-8 data but the connection charset was set to `latin1`
- Data was exported with one encoding and imported with another
- phpMyAdmin or MySQL Workbench used the wrong character set

### 11.2 Supported Languages & Scripts

The mojibake repair module supports:

| Script/Language | Examples |
|---|---|
| **Telugu** | తెలుగు, విశ్వరూపం |
| **Sanskrit/IAST** | ā, ī, ū, ṭ, ḍ, ṇ, ṣ, ṃ, ḥ, ṛ, ḷ, ś, ñ, ṅ |
| **Devanagari** | हिन्दी, संस्कृतम् |
| **Bengali** | বাংলা |
| **Malayalam** | മലയാളം |
| **Tamil** | தமிழ் |
| **Kannada** | ಕನ್ನಡ |
| **Cyrillic** | Русский |
| **Windows-1252** | Smart quotes (' ' " "), em-dashes (—), ellipsis (…) |

### 11.3 Repair Modes

| Mode | Behavior | When to Use |
|---|---|---|
| **auto** | Detect mojibake first; repair only if detected. Safe — leaves clean text untouched. | Default. Best for most cases. |
| **force** | Always attempt repair regardless of detection. | When you know ALL values in the column are corrupted. |
| **detect_only** | Flag corrupted text but don't modify it. | Auditing — see which rows are affected before repairing. |

### 11.4 How to Apply Mojibake Repair

#### Method 1: Use a Preset (Quickest)

1. Go to **Transform tab** (Step 3)
2. Find the column with corrupted text
3. In the **Transform** dropdown, select:
   - `preset:repair_unicode_mojibake` — for all Unicode corruption
   - `preset:repair_iast_mojibake` — specifically for IAST diacritics
4. Preview to verify the repair

#### Method 2: Configure Manually

1. Go to **Transform tab** (Step 3)
2. Find the column with corrupted text
3. In the **Transform** dropdown, select `mojibake_repair`
4. Configure the **Mode**:
   - `auto — detect and repair` (recommended)
   - `force — always repair`
   - `detect_only — flag but don't repair`
5. Preview to verify

### 11.5 How the Repair Works Internally

The repair engine works in two stages:

**Stage 1 — Byte-level reinterpretation:**
1. Attempts Windows-1252 → UTF-8 reinterpretation
2. If that doesn't work, tries ISO-8859-1 (Latin-1) → UTF-8 reinterpretation
3. Runs up to 2 passes for double-mojibake (text corrupted twice)

**Stage 2 — Fallback pattern replacement:**
- Uses a built-in map of known corrupted patterns → correct characters
- Covers IAST diacritics, Indic scripts, and Windows-1252 special characters

**Safety check:**
- If the repair introduces replacement characters (`�`), the original text is returned unchanged
- In `auto` mode, clean text is never modified

### 11.6 Verifying Repairs

After applying the mojibake repair transform:

1. Click **Preview all transforms** in the Transform tab
2. Compare **sampleRows** (before) with **transformedRows** (after)
3. Look for:
   - Garbled text in sampleRows → readable text in transformedRows ✅
   - Clean text in sampleRows → same clean text in transformedRows ✅
   - Any `�` replacement characters → something went wrong ❌

---

## 12. Complete Options Reference

### 12.1 Connection Options

#### MySQL Source

| Option | Type | Default | Notes |
|---|---|---|---|
| Host | string | — | MySQL hostname |
| Port | number | `3306` | MySQL port |
| User | string | — | MySQL username |
| Database | string | — | MySQL database name |
| Password | string | — | Provided at runtime, not saved |
| SSL mode | enum | `PREFERRED` | `PREFERRED`, `REQUIRED`, `DISABLED`, `VERIFY_CA`, `VERIFY_IDENTITY` |
| Connection string | string | — | Alternative to individual fields |
| Consistent read | object | `disabled` | For snapshot isolation: `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE` |

#### PostgreSQL Target

| Option | Type | Default | Notes |
|---|---|---|---|
| Connection string | string | — | Full PostgreSQL URI |
| Pooler host | string | — | Alternative to connection string |
| Pooler port | number | `5432` | PostgreSQL port |
| Pooler user | string | — | PostgreSQL username |
| Pooler database | string | — | PostgreSQL database |
| Pooler password | string | — | PostgreSQL password |
| SSL mode | enum | `prefer` | `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`, `no-verify` |

### 12.2 Table Mapping Options

| Option | Values | Default |
|---|---|---|
| Enabled | `true` / `false` | `true` |
| Source table | dropdown | — |
| Target table | dropdown or text | — |
| Target table mode | `existing` / `create_new` | `existing` |
| Write mode | `append` / `truncate` / `upsert` | `append` |
| Conflict strategy | `insert` / `upsert` / `truncate-load` | `insert` |
| Conflict keys | multi-select | `[]` |
| Chunk size | number | `500` |
| Load strategy mode | `historical_full` / `historical_filtered` / `incremental_watermark` / `historical_then_incremental` | `historical_full` |
| Watermark column | dropdown | — |
| Tie-breaker column | dropdown | auto/primary key |
| Lookback amount | number | `0` |
| Lookback unit | `minutes` / `hours` / `days` | `minutes` |
| Persist watermark | boolean | `true` |
| Delete handling | `none` / `soft_delete` | `none` |
| Create target table | boolean | `false` |

### 12.3 Column Mapping Options

| Option | Values | Default |
|---|---|---|
| Enabled | checkbox | `true` |
| Source column | dropdown | — |
| Target column mode | `existing` / `create_new` / `ignore` | `existing` |
| Target column | dropdown or text | — |
| Transform type | See Section 7.2 | `direct` |
| Transform config | Depends on type | `{}` |

### 12.4 Historical Filter Options

| Option | Values |
|---|---|
| Enabled | `enabled` / `disabled` |
| Filter column | Source column dropdown |
| Filter operator | `>`, `>=`, `<`, `<=`, `=`, `!=`, `between`, `like`, `is_null`, `is_not_null` |
| Filter value | Any value (string/number) |
| Filter end value | Only for `between` |

### 12.5 Execution Options

| Option | Values | Default |
|---|---|---|
| Run mode | `all` / `selected` | `all` |
| Error policy | `fail-fast` / `quarantine` | `fail-fast` |
| Concurrency | `1` – `n` | `1` |
| Batch size | `1` – `n` | `1000` |
| CDC mode | `off` / `snapshot-only` / `watermark` | `off` |
| Load phase | `configured` / `historical` / `incremental` | `configured` |
| Cutover mode | `manual` / `guarded` | `manual` |
| Watermark column | text | — |
| Dry run | checkbox | `false` |

### 12.6 Transform Types Reference

| Type | Config Fields | Example |
|---|---|---|
| `direct` | — | Pass-through |
| `string` | — | `123` → `"123"` |
| `number` | — | `"42"` → `42` |
| `boolean` | — | `1` → `true` |
| `json` | — | `'{"a":1}'` → `{a: 1}` |
| `date` | — | Parse date string |
| `datetime` | — | Parse datetime string |
| `constant` | `value` | Always write `"default_value"` |
| `null` | — | Always write `NULL` |
| `template` | `template`, `requiredColumns` | `"{{first}} {{last}}"` |
| `lookup` | `values`, `defaultValue` | `{1: "Y", 0: "N"}` |
| `lookup_table` | `table`, `localColumn`, `lookupColumn`, `valueColumn`, `missing`, `defaultValue` | Join with reference table |
| `expression` | `expression`, `requiredColumns` | `value > 0 ? 'active' : 'inactive'` |
| `concat` | `fields`, `delimiter` | `["first", "last"]` with `" "` |
| `coalesce` | `fields` | First non-null from list |
| `conditional` | `branches`, `otherwise` | If/then/else logic |
| `mojibake_repair` | `mode` | `auto` / `force` / `detect_only` |

---

## 13. Common Scenarios & Recipes

### Scenario 1: Full One-Time Migration

```
Write mode:     truncate
Strategy:       historical full load
Conflict keys:  (not needed)
Error policy:   fail-fast
```

### Scenario 2: Add Only New Rows (e.g., dcid > 5785)

```
Write mode:     append (or upsert for safety)
Strategy:       historical filtered load
Filter column:  dcid
Filter operator: >
Filter value:   5785
```

### Scenario 3: Ongoing Daily Sync

```
Write mode:     upsert
Conflict keys:  id
Strategy:       historical + then incremental
Watermark col:  updated_at
Lookback:       5 minutes
```

### Scenario 4: Fix Mojibake in Telugu/Sanskrit Text Columns

```
Transform type: mojibake_repair
Mode:          auto
```
Or use preset: `preset:repair_unicode_mojibake`

### Scenario 5: Migrate Selected Tables Only

```
Run mode:       selected
Selected tables: users, orders, products
Load phase:     configured per table
```

### Scenario 6: Retry-Safe Migration (Can Re-Run Without Duplicates)

```
Write mode:     upsert
Conflict keys:  id (must match PK or unique constraint)
Error policy:   quarantine
Strategy:       historical full load
```

---

## 14. Troubleshooting

### "Source MySQL password is required"
→ Re-enter the MySQL password in the Workspace tab. Passwords are not saved between sessions.

### "Target PostgreSQL password or connection string is required"
→ Re-enter the PostgreSQL connection string or password in the Workspace tab.

### "Execution gated — No enabled table mappings"
→ Go to Mapping tab, add at least one source → target table mapping, and save.

### "Verification is stale"
→ You changed mappings after running verification. Click **Verify project** again.

### "Transform preview is stale"
→ You changed transforms after previewing. Click **Preview all transforms** again.

### "Transform preview has errors"
→ Go to Transform tab, check the error messages, and fix your transform expressions.

### "Missing conflict keys"
→ Upsert mode needs conflict keys. In Mapping, select the column(s) that form your target table's primary key or unique constraint.

### "Target table does not exist"
→ Either select an existing table, enable "Create target table if it does not exist", or click **Provision target tables**.

### Duplicate rows after re-running
→ Switch write mode from `append` to `upsert` and set proper conflict keys.

### Mojibake repair not working
→ Try switching from `auto` mode to `force` mode. If text is double-encoded (corrupted twice), the auto-detection may need the force mode to attempt both passes.

### Very slow migration
→ Increase **Batch size** (e.g., `2000` or `5000`) and **Concurrency** (e.g., `2` or `3`). Make sure your PostgreSQL connection supports multiple concurrent connections.

---

> **Remember:** Always use a staging/test target first. Never start with a production database until you've verified the migration works correctly with dry runs.
