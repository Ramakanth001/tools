const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { redactConnectionString } = require('./redact');

async function commandExists(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function missingMysqlToolsError(missing) {
  const list = missing.map((m) => `- ${m}`).join('\n');
  const help =
    'MySQL client tools are required on this machine.\n\n' +
    'Install on macOS (Homebrew):\n' +
    '  brew install mysql-client\n\n' +
    'Or set absolute paths:\n' +
    '  export MYSQL_PATH="/opt/homebrew/opt/mysql-client/bin/mysql"\n' +
    '  export MYSQLDUMP_PATH="/opt/homebrew/opt/mysql-client/bin/mysqldump"\n';

  const err = new Error(`Missing required tools:\n${list}\n\n${help}`);
  err.code = 'MISSING_MYSQL_TOOLS';
  return err;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function emit(logFn, msg) {
  logFn(String(msg));
}

function spawnLogged(cmd, args, { env, cwd, log, onChild, isCancelled, stdoutFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(child);

    const stdoutChunks = [];
    const writer = stdoutFile ? fs.createWriteStream(stdoutFile) : null;

    child.stdout.on('data', (d) => {
      if (writer) writer.write(d);
      else stdoutChunks.push(d);
    });
    child.stderr.on('data', (d) => log(d.toString()));

    const cancelInterval = setInterval(() => {
      if (!isCancelled || !isCancelled()) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, 250);

    child.on('error', (err) => {
      clearInterval(cancelInterval);
      if (writer) writer.end();
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(cancelInterval);
      if (writer) writer.end();
      if (code === 0) return resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function parseList(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

function normalizeMysqlConnection(connection = {}) {
  const normalized = { ...connection };
  const raw = String(connection.connectionString || '').trim();
  if (!raw) return normalized;
  try {
    const url = new URL(raw);
    if (!['mysql:', 'mysql2:'].includes(url.protocol)) return normalized;
    if (url.hostname) normalized.host = url.hostname;
    if (url.port) normalized.port = Number(url.port);
    if (url.username) normalized.user = decodeURIComponent(url.username);
    if (url.password) normalized.password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname || '').replace(/^\//, '');
    if (database) normalized.database = database;
    const sslMode = url.searchParams.get('ssl-mode') || url.searchParams.get('sslMode') || url.searchParams.get('sslmode');
    if (sslMode) normalized.sslMode = sslMode;
    const sslCa = url.searchParams.get('ssl-ca') || url.searchParams.get('sslCa');
    const sslCert = url.searchParams.get('ssl-cert') || url.searchParams.get('sslCert');
    const sslKey = url.searchParams.get('ssl-key') || url.searchParams.get('sslKey');
    if (sslCa) normalized.sslCa = sslCa;
    if (sslCert) normalized.sslCert = sslCert;
    if (sslKey) normalized.sslKey = sslKey;
  } catch {
    // Invalid connection strings fall back to the explicit fields.
  }
  return normalized;
}

function buildMysqlArgs(connection) {
  const resolved = normalizeMysqlConnection(connection);
  const args = [
    `--host=${resolved.host}`,
    `--port=${Number(resolved.port || 3306)}`,
    `--user=${resolved.user}`,
  ];
  if (resolved.sslMode) args.push(`--ssl-mode=${resolved.sslMode}`);
  if (resolved.sslCa) args.push(`--ssl-ca=${resolved.sslCa}`);
  if (resolved.sslCert) args.push(`--ssl-cert=${resolved.sslCert}`);
  if (resolved.sslKey) args.push(`--ssl-key=${resolved.sslKey}`);
  return args;
}

function parseTableList(input) {
  return parseList(input)
    .map((item) => {
      const parts = item.split('.').map((x) => x.trim()).filter(Boolean);
      return { database: parts.length > 1 ? parts[0] : null, table: parts.length > 1 ? parts.slice(1).join('.') : parts[0] };
    })
    .filter((x) => x.table);
}

async function writeText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, text, 'utf8');
}

async function writeInventoryFile({ mysqlCmd, env, cwd, connection, sql, outPath, onChild, isCancelled, log }) {
  const query = `${sql}`;
  const resolved = normalizeMysqlConnection(connection);
  await spawnLogged(
    mysqlCmd,
    [...buildMysqlArgs(resolved), `--database=${resolved.database}`, '--batch', '--raw', '-e', query],
    { env, cwd, log, onChild, isCancelled, stdoutFile: outPath }
  );
}

async function runBackup({ connection, options, outDir, log, progress, onChild, isCancelled }) {
  const resolvedConnection = normalizeMysqlConnection(connection);
  const stamp = nowStamp();
  const jobDir = path.join(outDir, stamp);
  await fsp.mkdir(jobDir, { recursive: true });

  const env = { ...process.env, MYSQL_PWD: resolvedConnection.password || process.env.MYSQL_PWD || '' };
  const mysqlCmd = process.env.MYSQL_PATH || 'mysql';
  const mysqldump = process.env.MYSQLDUMP_PATH || 'mysqldump';

  const meta = {
    createdAt: new Date().toISOString(),
    options,
    connection: {
      host: resolvedConnection.host,
      port: Number(resolvedConnection.port || 3306),
      user: resolvedConnection.user,
      database: resolvedConnection.database,
      sslMode: resolvedConnection.sslMode || 'PREFERRED',
      connectionString: redactConnectionString(resolvedConnection.connectionString || ''),
    },
  };
  await writeText(path.join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2));

  emit(log, `Backup output folder: ${jobDir}`);
  emit(log, `Database: ${redactConnectionString(resolvedConnection.connectionString || `mysql://${resolvedConnection.user}:${resolvedConnection.password || ''}@${resolvedConnection.host}:${resolvedConnection.port}/${resolvedConnection.database}`)}`);

  const missing = [];
  if (options.fullDump || options.schemaOnly) {
    if (!(await commandExists(mysqldump))) missing.push(mysqldump === 'mysqldump' ? 'mysqldump' : `mysqldump (MYSQLDUMP_PATH=${mysqldump})`);
  }
  if (options.inventory) {
    if (!(await commandExists(mysqlCmd))) missing.push(mysqlCmd === 'mysql' ? 'mysql' : `mysql (MYSQL_PATH=${mysqlCmd})`);
  }
  if (missing.length) throw missingMysqlToolsError(missing);

  const report = (p) => (progress ? progress(p) : undefined);
  const includeTables = parseTableList(options.tableInclude).filter((x) => !x.database || x.database === resolvedConnection.database);
  const excludeTables = parseTableList(options.tableExclude).filter((x) => !x.database || x.database === resolvedConnection.database);

  function throwIfCancelled() {
    if (isCancelled && isCancelled()) {
      const err = new Error('Job cancelled');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
  }

  report({ phase: 'preflight', percent: 5 });
  throwIfCancelled();

  const tableArgs = includeTables.map((x) => x.table);
  const ignoreArgs = excludeTables.map((x) => `--ignore-table=${resolvedConnection.database}.${x.table}`);

  if (options.fullDump) {
    emit(log, 'Running mysqldump (full SQL) ...');
    await spawnLogged(
      mysqldump,
      [...buildMysqlArgs(resolvedConnection), '--single-transaction', '--routines', '--events', '--triggers', '--skip-comments', '--column-statistics=0', ...ignoreArgs, resolvedConnection.database, ...tableArgs],
      { env, cwd: jobDir, log, onChild, isCancelled, stdoutFile: path.join(jobDir, 'db.sql') }
    );
    report({ phase: 'fullDump', percent: 45 });
    throwIfCancelled();
  }

  if (options.schemaOnly) {
    emit(log, 'Running mysqldump (schema-only) ...');
    await spawnLogged(
      mysqldump,
      [...buildMysqlArgs(resolvedConnection), '--no-data', '--routines', '--events', '--triggers', '--skip-comments', '--column-statistics=0', ...ignoreArgs, resolvedConnection.database, ...tableArgs],
      { env, cwd: jobDir, log, onChild, isCancelled, stdoutFile: path.join(jobDir, 'schema.sql') }
    );
    report({ phase: 'schemaOnly', percent: 70 });
    throwIfCancelled();
  }

  if (options.inventory) {
    emit(log, 'Running inventory queries (mysql) ...');
    const invDir = path.join(jobDir, 'inventory');
    await fsp.mkdir(invDir, { recursive: true });
    const dbName = resolvedConnection.database.replace(/'/g, "''");
    const queries = [
      ['tables.tsv', `select table_schema, table_name, engine, table_rows from information_schema.tables where table_schema = '${dbName}' order by table_name;`],
      ['views.tsv', `select table_schema, table_name from information_schema.views where table_schema = '${dbName}' order by table_name;`],
      ['routines.tsv', `select routine_schema, routine_name, routine_type from information_schema.routines where routine_schema = '${dbName}' order by routine_name;`],
      ['triggers.tsv', `select trigger_schema, trigger_name, event_object_table, action_timing, event_manipulation from information_schema.triggers where trigger_schema = '${dbName}' order by trigger_name;`],
    ];

    for (const [file, sql] of queries) {
      emit(log, `Query: ${file}`);
      await writeInventoryFile({ mysqlCmd, env, cwd: jobDir, connection: resolvedConnection, sql, outPath: path.join(invDir, file), onChild, isCancelled, log });
      throwIfCancelled();
    }
    report({ phase: 'inventory', percent: 90 });
  }

  report({ phase: 'finalizing', percent: 95 });
  emit(log, 'Backup job finished.');
  return { jobDir, stamp };
}

module.exports = { runBackup, buildMysqlArgs, normalizeMysqlConnection };
