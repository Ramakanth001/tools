const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

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
  logFn(String(msg));
}

function spawnLogged(cmd, args, { env, cwd, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d) => log(d.toString()));
    child.stderr.on('data', (d) => log(d.toString()));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function writeText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, text, 'utf8');
}

async function runBackup({ connectionString, options, outDir, log }) {
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

  const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
  const psql = process.env.PSQL_PATH || 'psql';

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
        '--file',
        dumpPath,
        connectionString,
      ],
      { env, cwd: jobDir, log }
    );
  }

  if (options.schemaOnly) {
    emit(log, 'Running pg_dump (schema-only) ...');
    const schemaPath = path.join(jobDir, 'schema.sql');
    await spawnLogged(
      pgDump,
      ['--schema-only', '--no-owner', '--no-privileges', '--file', schemaPath, connectionString],
      { env, cwd: jobDir, log }
    );
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

        const ws = fs.createWriteStream(outPath);
        child.stdout.pipe(ws);
        child.stderr.on('data', (d) => log(d.toString()));

        child.on('error', reject);
        child.on('close', (code) => {
          ws.end();
          if (code === 0) return resolve();
          reject(new Error(`psql exited with code ${code} for ${q.file}`));
        });
      });
    }
  }

  emit(log, 'Backup job finished.');
  return { jobDir, stamp };
}

module.exports = { runBackup };
