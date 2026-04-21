# mysql-pg-migrate

Web UI and API for guiding a MySQL-to-PostgreSQL migration workflow.

## What it does

This tool is intended to help you:

- connect to a source MySQL database
- connect to a target PostgreSQL database
- inspect source and target schemas
- generate automatic mapping suggestions
- run preflight validation
- build dry-run previews
- execute and monitor migration runs
- resume or rerun failed runs
- export and import project mappings

## Run modes

### mysql-pg-migrate only

From the repo root:

```bash
npm --prefix ./mysql-pg-migrate run dev
```

Or from this folder:

```bash
cd mysql-pg-migrate
npm run dev
```

Open:

- UI: `http://localhost:5175`
- API health: `http://localhost:8789/api/health`

This mode starts the Express API and the Vite development UI together.

### Production build

From the repo root:

```bash
npm --prefix ./mysql-pg-migrate run build
npm --prefix ./mysql-pg-migrate run start
```

Or from this folder:

```bash
cd mysql-pg-migrate
npm run build
npm run start
```

Open:

- Built app/API: `http://localhost:8789`

Use `npm run build` first so the server can serve the generated `public/index.html`.

### Preview build

```bash
cd mysql-pg-migrate
npm run preview
```

Default preview UI:

- `http://localhost:5175`

## Current access model

At the moment, `mysql-pg-migrate` is set up as a standalone tool.

It is not yet wired into the shared host routes like:

- `/tools/pg-backup`
- `/tools/mysql-tool`

So for now, run and access it directly via its own ports.

## Default ports

- Dev UI: `5175`
- Standalone app/API: `8789`

## Notes

- The backend routes for introspection, mapping, preflight, dry-run, runs, and reports are already present.
- The current standalone UI is a basic scaffold, and the API can still be accessed directly at `/api/...` on port `8789`.
- Example health endpoint: `http://localhost:8789/api/health`
- Runtime dependencies such as `pg` are resolved from the tool package or shared workspace dependencies.