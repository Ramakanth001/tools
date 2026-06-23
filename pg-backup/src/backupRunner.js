const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { redactConnectionString } = require('./redact');

async function commandExists(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function missingPgToolsError(missing) {
  const list = missing.map((m) => `- ${m}`).join('\n');
  const help =
    "PostgreSQL client tools are required on this machine.\n\n" +
    "Install on macOS (Homebrew):\n" +
    "  brew install postgresql@16\n" +
    "  brew link --force postgresql@16\n\n" +
    "Or set absolute paths:\n" +
    "  export PG_DUMP_PATH=\"/opt/homebrew/opt/postgresql@16/bin/pg_dump\"\n" +
    "  export PSQL_PATH=\"/opt/homebrew/opt/postgresql@16/bin/psql\"\n";

  const err = new Error(`Missing required tools:\n${list}\n\n${help}`);
  err.code = 'MISSING_PG_TOOLS';
  return err;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    '_' +
    pad(d.getHours()) +
    '-' +
    pad(d.getMinutes()) +
    '-' +
    pad(d.getSeconds())
  );
}

function emit(logFn, msg) {
  logFn(redactConnectionString(String(msg)));
}

function spawnLogged(cmd, args, { env, cwd, log, onChild, isCancelled }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (onChild) onChild(child);

    child.stdout.on('data', (d) => log(redactConnectionString(d.toString())));
    child.stderr.on('data', (d) => log(redactConnectionString(d.toString())));

    const cancelInterval = setInterval(() => {
      if (!isCancelled) return;
      if (!isCancelled()) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, 250);

    child.on('error', reject);
    child.on('close', (code) => {
      clearInterval(cancelInterval);
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function parseList(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildPgDumpFilters(options) {
  const args = [];

  const schemaInclude = parseList(options.schemaInclude);
  const schemaExclude = parseList(options.schemaExclude);
  const tableInclude = parseList(options.tableInclude);
  const tableExclude = parseList(options.tableExclude);

  // Note: pg_dump filtering can be subtle:
  // - --schema=... limits to schemas
  // - --exclude-schema=... excludes schemas
  // - --table=... supports schema-qualified names
  // - --exclude-table=... excludes tables
  for (const s of schemaInclude) args.push(`--schema=${s}`);
  for (const s of schemaExclude) args.push(`--exclude-schema=${s}`);
  for (const t of tableInclude) args.push(`--table=${t}`);
  for (const t of tableExclude) args.push(`--exclude-table=${t}`);

  return args;
}

async function writeText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, text, 'utf8');
}

async function runBackup({ connectionString, options, outDir, log, progress, onChild, isCancelled }) {
  const stamp = nowStamp();
  const jobDir = path.join(outDir, stamp);
  await fsp.mkdir(jobDir, { recursive: true });

  const env = {
    ...process.env,
    // libpq tools accept connection string via DATABASE_URL
    DATABASE_URL: connectionString,
  };

  const meta = {
    createdAt: new Date().toISOString(),
    options,
  };
  await writeText(path.join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2));

  emit(log, `Backup output folder: ${jobDir}`);
  emit(log, `Database: ${redactConnectionString(connectionString)}`);

  const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
  const psql = process.env.PSQL_PATH || 'psql';

  const pgDumpFilters = buildPgDumpFilters(options);

  // Hard preflight: fail fast with a clear message if tools are missing.
  const missing = [];
  if (options.fullDump || options.schemaOnly) {
    const ok = await commandExists(pgDump);
    if (!ok) missing.push(pgDump === 'pg_dump' ? 'pg_dump' : `pg_dump (PG_DUMP_PATH=${pgDump})`);
  }
  if (options.inventory) {
    const ok = await commandExists(psql);
    if (!ok) missing.push(psql === 'psql' ? 'psql' : `psql (PSQL_PATH=${psql})`);
  }
  if (missing.length) {
    throw missingPgToolsError(missing);
  }

  const emitProgress = (p) => {
    if (typeof options?.progress === 'function') options.progress(p);
  };

  const report = (p) => (progress ? progress(p) : undefined);

  function throwIfCancelled() {
    if (isCancelled && isCancelled()) {
      const err = new Error('Job cancelled');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
  }

  report({ phase: 'preflight', percent: 5 });
  throwIfCancelled();

  if (options.fullDump) {
    emit(log, 'Running pg_dump (custom format) ...');
    const dumpPath = path.join(jobDir, 'db.dump');
    await spawnLogged(
      pgDump,
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--verbose',
        ...pgDumpFilters,
        '--file',
        dumpPath,
        connectionString,
      ],
      { env, cwd: jobDir, log, onChild, isCancelled }
    );
    report({ phase: 'fullDump', percent: 35 });
    throwIfCancelled();
  }

  if (options.schemaOnly) {
    emit(log, 'Running pg_dump (schema-only) ...');
    const schemaPath = path.join(jobDir, 'schema.sql');
    await spawnLogged(
      pgDump,
      ['--schema-only', '--no-owner', '--no-privileges', ...pgDumpFilters, '--file', schemaPath, connectionString],
      { env, cwd: jobDir, log, onChild, isCancelled }
    );
    report({ phase: 'schemaOnly', percent: 55 });
    throwIfCancelled();
  }

  if (options.plainSql) {
    emit(log, 'Running pg_dump (plain SQL) ...');
    const sqlPath = path.join(jobDir, 'db.sql');
    await spawnLogged(
      pgDump,
      ['--format=plain', '--no-owner', '--no-privileges', ...pgDumpFilters, '--file', sqlPath, connectionString],
      { env, cwd: jobDir, log, onChild, isCancelled }
    );
    report({ phase: 'plainSql', percent: 70 });
    throwIfCancelled();
  }

  if (options.inventory) {
    emit(log, 'Running inventory queries (psql) ...');
    const invDir = path.join(jobDir, 'inventory');
    await fsp.mkdir(invDir, { recursive: true });

    const queries = [
      {
        file: 'extensions.csv',
        sql: "COPY (SELECT extname, extversion, extnamespace::regnamespace::text FROM pg_extension ORDER BY extname) TO STDOUT WITH CSV HEADER;",
      },
      {
        file: 'rls_policies.csv',
        sql: 'COPY (SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies ORDER BY schemaname, tablename, policyname) TO STDOUT WITH CSV HEADER;',
      },
      {
        file: 'tables.csv',
        sql: "COPY (SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name) TO STDOUT WITH CSV HEADER;",
      },
      {
        file: 'db_size.csv',
        sql: "COPY (SELECT current_database() AS db, pg_database_size(current_database()) AS bytes) TO STDOUT WITH CSV HEADER;",
      },
      {
        file: 'schema_sizes.csv',
        sql: "COPY (SELECT n.nspname AS schema, SUM(pg_total_relation_size(c.oid))::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') GROUP BY n.nspname ORDER BY bytes DESC) TO STDOUT WITH CSV HEADER;",
      },
    ];

    for (const q of queries) {
      emit(log, `Query: ${q.file}`);
      const outPath = path.join(invDir, q.file);
      await new Promise((resolve, reject) => {
        const child = spawn(psql, [connectionString, '-v', 'ON_ERROR_STOP=1', '-q', '-c', q.sql], {
          env,
          cwd: jobDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (onChild) onChild(child);

        const ws = fs.createWriteStream(outPath);
        child.stdout.pipe(ws);
        child.stderr.on('data', (d) => log(redactConnectionString(d.toString())));

        const cancelInterval = setInterval(() => {
          if (!isCancelled) return;
          if (!isCancelled()) return;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }, 250);

        child.on('error', reject);
        child.on('close', (code) => {
          clearInterval(cancelInterval);
          ws.end();
          if (code === 0) return resolve();
          reject(new Error(`psql exited with code ${code} for ${q.file}`));
        });
      });
      throwIfCancelled();
    }
    report({ phase: 'inventory', percent: 85 });
  }

  if (options.roles) {
    // Best-effort: dump globals via pg_dumpall if available; otherwise skip.
    const pgDumpAll = process.env.PG_DUMPALL_PATH || 'pg_dumpall';
    const ok = await commandExists(pgDumpAll);
    if (ok) {
      emit(log, 'Dumping globals (roles/privileges) via pg_dumpall ...');
      const globalsPath = path.join(jobDir, 'globals.sql');
      await new Promise((resolve, reject) => {
        const child = spawn(pgDumpAll, ['--globals-only', '--no-role-passwords', `--dbname=${connectionString}`], {
          env,
          cwd: jobDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (onChild) onChild(child);

        const ws = fs.createWriteStream(globalsPath);
        child.stdout.pipe(ws);
        child.stderr.on('data', (d) => log(redactConnectionString(d.toString())));

        const cancelInterval = setInterval(() => {
          if (!isCancelled) return;
          if (!isCancelled()) return;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }, 250);

        child.on('error', (e) => {
          clearInterval(cancelInterval);
          reject(e);
        });
        child.on('close', (code) => {
          clearInterval(cancelInterval);
          ws.end();
          if (code === 0) return resolve();
          reject(new Error(`pg_dumpall exited with code ${code}`));
        });
      }).catch((e) => {
        emit(log, `WARN: globals dump failed: ${e?.message || String(e)}`);
      });
    } else {
      emit(log, 'WARN: pg_dumpall not found; skipping roles/privileges dump.');
    }
    report({ phase: 'roles', percent: 90 });
    throwIfCancelled();
  }

  report({ phase: 'finalizing', percent: 95 });
  emit(log, 'Backup job finished.');
  return { jobDir, stamp };
}

module.exports = { runBackup };
