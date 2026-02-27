# pg-backup

Local web UI to create **real PostgreSQL backups** using `pg_dump` and export a single **zip**.

## What it generates

For each run it creates a timestamped folder under `backups/` and then a zip containing:

- `db.dump` (custom format) **if enabled**
- `schema.sql` (schema-only) **if enabled**
- `inventory/` CSVs (extensions, RLS policies, tables list) **if enabled**
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

## Using Supabase Pooler (recommended)

You can connect via Supabase Pooler instead of the direct DB host.

Example pooler settings:

- Host: `aws-1-ap-south-1.pooler.supabase.com`
- Port: `5432`
- User: `postgres.cughfeafhxhumjbijlpr`
- Database: `postgres`

TLS is required. This tool enforces `sslmode=require` automatically.

## Notes

- This is intentionally a **local-only** tool. Credentials are sent only to `localhost`.
- For large DBs, dumps can take time.

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
```
