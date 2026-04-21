const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

function buildMysqlArgs(connection, { includePassword = false } = {}) {
  const args = [
    `--host=${connection.host}`,
    `--port=${Number(connection.port || 3306)}`,
    `--user=${connection.user}`,
    '--batch',
    '--raw',
    '--skip-column-names',
  ];
  if (includePassword && connection.password) args.push(`--password=${connection.password}`);
  if (connection.sslMode) args.push(`--ssl-mode=${connection.sslMode}`);
  return args;
}

function runMysqlQuery(connection, sql) {
  const mysqlCmd = process.env.MYSQL_PATH || 'mysql';
  const env = { ...process.env, MYSQL_PWD: connection.password || process.env.MYSQL_PWD || '' };
  return new Promise((resolve, reject) => {
    const child = spawn(mysqlCmd, [...buildMysqlArgs(connection), `--database=${connection.database}`, '-e', sql], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.stderr.on('data', (chunk) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `mysql exited with code ${code}`));
      resolve(out.trim());
    });
  });
}

function tabLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

async function listMysqlSchemas(connection) {
  const raw = await runMysqlQuery(connection, `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY schema_name;`);
  return tabLines(raw).map((row) => row[0]);
}

function normalizeBooleanish(column) {
  return /tinyint\(1\)/i.test(column.fullType || '') || /boolean/i.test(column.dataType || '');
}

async function introspectMysqlSchema(connection, { schema, includeViews = false }) {
  const safeSchema = String(schema || connection.database).replace(/'/g, "''");
  const tablesRaw = await runMysqlQuery(connection, `
    SELECT table_name, table_type, engine, table_rows, table_collation, table_comment
    FROM information_schema.tables
    WHERE table_schema='${safeSchema}'
    ORDER BY table_name;
  `);
  const columnsRaw = await runMysqlQuery(connection, `
    SELECT table_name, ordinal_position, column_name, column_type, data_type, is_nullable, column_default,
           extra, column_key, character_set_name, collation_name, column_comment, generation_expression
    FROM information_schema.columns
    WHERE table_schema='${safeSchema}'
    ORDER BY table_name, ordinal_position;
  `);
  const statsRaw = await runMysqlQuery(connection, `
    SELECT table_name, index_name, non_unique, seq_in_index, column_name, sub_part, index_type
    FROM information_schema.statistics
    WHERE table_schema='${safeSchema}'
    ORDER BY table_name, index_name, seq_in_index;
  `);
  const fkRaw = await runMysqlQuery(connection, `
    SELECT kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.ordinal_position,
           kcu.referenced_table_name, kcu.referenced_column_name,
           rc.update_rule, rc.delete_rule
    FROM information_schema.key_column_usage kcu
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = kcu.constraint_schema
     AND rc.table_name = kcu.table_name
     AND rc.constraint_name = kcu.constraint_name
    WHERE kcu.table_schema='${safeSchema}'
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position;
  `);

  const tables = tabLines(tablesRaw).map((row) => ({
    name: row[0],
    type: row[1] === 'VIEW' ? 'view' : 'table',
    engine: row[2] || null,
    rowEstimate: Number(row[3] || 0),
    collation: row[4] || null,
    comment: row[5] || '',
  })).filter((table) => includeViews || table.type === 'table');

  const columnsByTable = new Map();
  for (const row of tabLines(columnsRaw)) {
    const item = {
      table: row[0],
      ordinal: Number(row[1]),
      name: row[2],
      fullType: row[3],
      dataType: row[4],
      nullable: row[5] === 'YES',
      defaultValue: row[6] || null,
      extra: row[7] || '',
      key: row[8] || '',
      charset: row[9] || null,
      collation: row[10] || null,
      comment: row[11] || '',
      generationExpression: row[12] || '',
    };
    item.autoIncrement = /auto_increment/i.test(item.extra);
    item.generated = /generated/i.test(item.extra) || Boolean(item.generationExpression);
    item.invisible = /invisible/i.test(item.extra);
    item.booleanish = normalizeBooleanish(item);
    if (!columnsByTable.has(item.table)) columnsByTable.set(item.table, []);
    columnsByTable.get(item.table).push(item);
  }

  const indexesByTable = new Map();
  for (const row of tabLines(statsRaw)) {
    const entry = {
      table: row[0],
      name: row[1],
      unique: row[2] === '0',
      seq: Number(row[3] || 0),
      column: row[4],
      subPart: row[5] || null,
      type: row[6] || 'BTREE',
    };
    if (!indexesByTable.has(entry.table)) indexesByTable.set(entry.table, []);
    indexesByTable.get(entry.table).push(entry);
  }

  const fksByTable = new Map();
  for (const row of tabLines(fkRaw)) {
    const entry = {
      table: row[0],
      name: row[1],
      column: row[2],
      ordinal: Number(row[3] || 0),
      referencedTable: row[4],
      referencedColumn: row[5],
      updateRule: row[6] || 'NO ACTION',
      deleteRule: row[7] || 'NO ACTION',
    };
    if (!fksByTable.has(entry.table)) fksByTable.set(entry.table, []);
    fksByTable.get(entry.table).push(entry);
  }

  const catalogTables = tables.map((table) => {
    const columns = columnsByTable.get(table.name) || [];
    const indexes = indexesByTable.get(table.name) || [];
    const pk = columns.filter((col) => col.key === 'PRI').map((col) => col.name);
    const foreignKeys = fksByTable.get(table.name) || [];
    return {
      name: table.name,
      kind: table.type,
      engine: table.engine,
      rowEstimate: table.rowEstimate,
      collation: table.collation,
      comment: table.comment,
      primaryKey: pk,
      columns,
      indexes,
      foreignKeys,
    };
  });

  const metadata = {
    engine: 'mysql',
    schema: safeSchema,
    tables: catalogTables,
    capabilities: {
      includeViews,
      sampledAt: new Date().toISOString(),
    },
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(catalogTables)).digest('hex'),
  };
  return metadata;
}

async function sampleMysqlTableRows(connection, schema, tableName, limit = 5) {
  const safeSchema = String(schema || connection.database).replace(/'/g, "''");
  const safeTable = String(tableName || '').replace(/`/g, '``');
  const raw = await runMysqlQuery(connection, `SELECT * FROM \`${safeSchema}\`.\`${safeTable}\` LIMIT ${Math.max(1, Number(limit) || 5)};`);
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  return lines.map((line) => ({ __raw: line }));
}

module.exports = { listMysqlSchemas, introspectMysqlSchema, sampleMysqlTableRows, runMysqlQuery };