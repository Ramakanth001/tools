# Implementation Gaps And Bug Queue

This file tracks the bugs found during the documentation pass and the fix status after the hardening pass.

## Verification

Commands run successfully:

```bash
npm --prefix ./mysql-pg-migrate test
npm run build
npm --prefix ./pg-backup run build
npm --prefix ./mysql-tool run build
npm --prefix ./mysql-pg-migrate run build
node --check src/runPackageBin.js
node --check src/localAuth.js
node --check src/jobStore.js
node --check mysql-pg-migrate/src/registerRoutes.js
node --check pg-backup/src/registerRoutes.js
node --check mysql-tool/src/registerRoutes.js
node --check mysql-pg-migrate/src/lib/executionEngine.js
node --check mysql-pg-migrate/src/lib/postgresIntrospector.js
```

## Fixed In This Pass

### P0 Security And Exposure Bugs

1. **Migration workspace credentials persisted in localStorage**

   Fixed. The migration UI strips database passwords, SSL private keys, and full connection strings before saving workspace state. A `Clear local credentials` action was added.

2. **Imported migration project IDs could become filesystem paths**

   Fixed. Project, run, watermark, replay, error, and checkpoint IDs now use a strict `^[A-Za-z0-9_-]+$` allowlist, and persistence verifies resolved paths stay under the expected state directory.

3. **Servers bound without an explicit host and had no auth boundary**

   Fixed for local-tool use. All servers bind to `127.0.0.1` by default. Non-loopback `HOST` values now require `TOOLS_AUTH_TOKEN`, and API/SSE/download clients forward the token.

4. **Database credentials leaked through subprocess argv**

   Fixed for active backup paths. PostgreSQL CLI tools now receive credentials through `PG*` environment variables, and MySQL CLI tools use `MYSQL_PWD` instead of `--password=...`.

### P1 Correctness And Operator-Safety Bugs

5. **MySQL connection strings were accepted but not used**

   Fixed. `mysql://` and `mysql2://` URLs are parsed for MySQL backup and migration connections. URL credentials satisfy password checks.

6. **Backup job history was in memory only**

   Fixed. Backup jobs persist metadata under `.jobs` beside backup artifacts and rehydrate on startup. Existing timestamped artifacts are listed as rehydrated jobs.

7. **Migration dry-run reports persisted sample rows and transformed rows**

   Fixed. Transform-preview and dry-run API responses still include live samples for the UI, but persisted reports redact row payloads and store counts.

8. **Schema provisioning was not fully idempotent**

   Fixed. Generated constraint DDL is wrapped in catalog existence checks so re-running provisioning does not fail on existing constraints.

9. **Create-table provisioning duplicated unique enforcement**

   Fixed. Unique indexes that duplicate source unique-key constraints are skipped during provisioning-plan generation.

10. **Migration runs could not be cancelled**

   Fixed. Migration runs now have a cancel endpoint, UI cancel button, cancellation state, and execution-loop checks between chunks/tables.

11. **Dependency scripts hard-coded `pg-backup/node_modules`**

   Fixed. Scripts now use `src/runPackageBin.js` to resolve local package binaries without coupling to one subtool install.

12. **Generated Vite assets were ignored inconsistently**

   Fixed for future builds. `.gitignore` now ignores `**/public/assets/*`.

### P2 Hardening Bugs

13. **Expression transforms treated Node `vm` as stronger isolation than it is**

   Partially fixed. Expression transforms now reject known escape-hatch tokens such as `constructor`, `__proto__`, `prototype`, `Function`, `eval`, `require`, `process`, and `globalThis` before compiling.

14. **Test coverage was narrow**

   Improved. Added regression tests for expression safety, MySQL URL normalization, idempotent constraint SQL, and unsafe persistence IDs.

15. **MySQL SSL verification modes lacked CA/cert configuration**

   Fixed. Migration driver connections accept CA/cert/key material. MySQL CLI backups accept CA/cert/key file paths.

16. **PostgreSQL pool cache had no lifecycle**

   Fixed. The migration PostgreSQL pool cache is capped, evicts least-recently-used pools, and closes pools on migration-server shutdown.

## Remaining Follow-Ups

- Replace custom expression transforms with a purpose-built expression language or a small safe evaluator. The current denylist is a hardening improvement, not a formal sandbox.
- Add database-backed integration tests using disposable PostgreSQL/MySQL containers for backup, provisioning, resume, rerun, cancellation, SSL, and cleanup flows.
- Decide whether generated `public/` build outputs should stay tracked at all. New hashed assets are ignored, but existing tracked generated files may still appear in git history until intentionally cleaned up.
- Add report retention/cleanup controls for migration reports, replays, errors, checkpoints, and watermarks.
- Add a more user-friendly token entry screen for non-loopback deployments instead of relying on `?token=...`.
- Consider encrypting persisted backup job metadata and migration state when the workspace is used on shared machines.
