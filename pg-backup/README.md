# pg-backup

Local web UI to create **real PostgreSQL backups** using `pg_dump` and export a single **zip**.

Now includes a production-grade UI (light + dark mode), job history, retention cleanup, cancellation, and streaming zip generation.

## What it generates

For each run it creates a timestamped folder under `backups/` and then a zip containing:

- `db.dump` (custom format) **if enabled**
- `db.sql` (plain SQL) **if enabled**
- `schema.sql` (schema-only) **if enabled**
- `inventory/` CSVs (extensions, RLS policies, tables list) **if enabled**
- `inventory/db_size.csv` and `inventory/schema_sizes.csv` **if enabled**
- `globals.sql` (roles/privileges) **if enabled** (requires `pg_dumpall`)
- `meta.json`

## Requirements

This tool shells out to:

- `pg_dump`
- `psql`

On your machine they are currently missing, so you must install PostgreSQL client tools.

On macOS (Homebrew):

```bash
brew install postgresql@16
brew link --force postgresql@16
```

If you installed another version (e.g. `postgresql@18`), that is also fine — just ensure the binaries are discoverable:

```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Then verify:

```bash
pg_dump --version
psql --version
```

If `brew link` is not desired, you can set absolute paths:

```bash
export PG_DUMP_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
export PSQL_PATH="/opt/homebrew/opt/postgresql@16/bin/psql"

# optional
export PG_DUMPALL_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dumpall"
```

## Run

```bash
cd tools/pg-backup
npm install
npm run dev
```

Open:

http://localhost:8787

Paste your Supabase DB connection string (Supabase Dashboard → Settings → Database → Connection string).

## How to use (step-by-step)

1) Start the app:

```bash
cd tools/pg-backup
npm install
npm run dev
```

2) Open the UI:

http://localhost:8787

3) Choose **one** connection method:

- **Option A: Pooler fields** (recommended for Supabase)
- **Option B: Full connection string** (works for any Postgres)

4) Click **Test connection**

5) Pick artifacts under **Backup options → Artifacts**

6) (Optional) Configure filters under **Backup options → Filters**

7) Click **Run backup**

8) When status is **Done**, click **Download zip**.

The output is also written to a timestamped folder under `backups/`.

---

## Connection methods

### A) Supabase (Pooler fields)

Where to get values:

1) Supabase Dashboard → **Project Settings** → **Database** → **Connection string**
2) Pick the **Pooler** section (Transaction pooler is typically best for tools).

Fields mapping:

- **Host**: pooler host (example: `aws-1-ap-south-1.pooler.supabase.com`)
- **Port**: usually `5432`
- **User**: looks like `postgres.<project-ref>`
- **Database**: usually `postgres`
- **Password**: the **database password** from Supabase (not an API key)

Notes:

- TLS is required; this tool enforces `sslmode=require`.
- If you paste a full connection string, pooler fields are ignored.

Pooler variants:

- **Transaction pooler**: recommended for most tooling.
- **Session pooler**: can also work, but transaction pooler is usually preferred.

### B) Any Postgres (full connection string)

Paste a connection string like:

```text
postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

Examples:

```text
postgresql://postgres:mysecret@127.0.0.1:5432/postgres
postgresql://appuser:pw@db.internal:5432/app?sslmode=require
```

Tip: if your server requires TLS, include `?sslmode=require` (or the UI will add it when missing for postgres URLs).

---

## Backup options

### Artifacts

- **Full dump (custom)** → `db.dump`
- **Schema-only** → `schema.sql`
- **Plain SQL dump** → `db.sql`
- **Inventory CSV exports** → `inventory/*.csv` (includes sizes)
- **Roles/privileges** → `globals.sql` (requires `pg_dumpall`)

### Filters (schemas/tables)

All filter fields are **comma-separated**.

Default behavior (when you leave fields blank):

- **Schema include** blank → include **all schemas**
- **Schema exclude** blank → exclude **none**
- **Table include** blank → include **all tables**
- **Table exclude** blank → exclude **none**

Examples:

- Only dump `public` and `auth` schemas:

  - Schema include: `public,auth`

- Exclude `storage` schema:

  - Schema exclude: `storage`

- Only include a few tables:

  - Table include: `public.users,public.orders`

Tip: use **schema-qualified** table names for clarity.

## Notes

- This is intentionally a **local-only** tool. Credentials are sent only to `localhost`.
- For large DBs, dumps can take time.
- Zipping is done via a streaming zip implementation (does not buffer the entire archive in memory).

## UI features

- Light mode by default + **dark mode toggle** (persisted in localStorage)
- Tabs: Run / History / Settings
- **Profiles**: save connection presets (password is never stored)
- **Job history**: list/search/download/delete
- **Retention cleanup**: delete old jobs by days / keep count
- **Cancel job**: cancels running backup (sends SIGTERM to child processes)

## Advanced backup options

- Schema include/exclude (comma-separated)
- Table include/exclude (comma-separated, schema-qualified recommended)
- Plain SQL dump option
- Roles/privileges artifact (`globals.sql`) via `pg_dumpall --globals-only` (if available)

## Retention

Retention cleanup is manual: go to **History** → set **Days** + **Keep** → click **Cleanup**.

Defaults are conservative (e.g. 30 days / 200 jobs). There is also a **Max retention** preset button in the UI.

## Troubleshooting

### Job fails with "Missing required tools" / "spawn pg_dump ENOENT"

That means `pg_dump` (and optionally `psql`) is not available in your shell PATH.

Fix options:

1) Install + link via Homebrew:

```bash
brew install postgresql@16
brew link --force postgresql@16
```

2) Or set absolute binary paths for this tool:

```bash
export PG_DUMP_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
export PSQL_PATH="/opt/homebrew/opt/postgresql@16/bin/psql"
export PG_DUMPALL_PATH="/opt/homebrew/opt/postgresql@16/bin/pg_dumpall" # optional
```
