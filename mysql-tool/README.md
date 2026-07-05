# mysql-tool

Local web UI to create real MySQL backups using `mysqldump` and `mysql`, with zipped downloads and saved profiles.

## Features

- Connection form for host, port, user, password, database, `mysql://` URLs, and SSL mode
- Optional MySQL CLI SSL CA/cert/key file paths
- Test connection
- Full SQL dump
- Schema-only dump
- Inventory exports from `information_schema`
- Job history and retention cleanup
- Cancel running jobs
- Download zipped output
- Saved profiles in localStorage (password is never stored)

## Requirements

This tool shells out to:

- `mysqldump`
- `mysql`

Install on macOS:

```bash
brew install mysql-client
```

Optional explicit paths:

```bash
export MYSQL_PATH="/opt/homebrew/opt/mysql-client/bin/mysql"
export MYSQLDUMP_PATH="/opt/homebrew/opt/mysql-client/bin/mysqldump"
```

## Run modes

### mysql-tool only

From the repo root:

```bash
npm run dev:mysql-tool
```

Or from this folder:

```bash
cd mysql-tool
npm run dev
```

Open:

- UI: `http://localhost:5174`
- API: `http://localhost:8788/api/health`

### All tools host

From the repo root:

```bash
npm run dev:all
```

Open:

- Host UI: `http://localhost:5173`
- MySQL tool route: `http://localhost:5173/tools/mysql-tool`
- Host API health: `http://localhost:8787/api/health`

### Production build

Standalone MySQL tool:

```bash
npm run build:mysql-tool
npm run start:mysql-tool
```

All tools host:

```bash
npm run build:all
npm run start:all
```

## Output

Each run creates a timestamped folder under `mysql-tool/backups/` and then a zip containing files such as:

- `db.sql`
- `schema.sql`
- `inventory/*.tsv`
- `meta.json`
