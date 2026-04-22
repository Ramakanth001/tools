const crypto = require('node:crypto');
const { requireToolDep } = require('../../requireToolDep');

const mysql = requireToolDep('mysql2/promise');

function buildMysqlConnectionConfig(connection, { database } = {}) {
  return {
    host: connection.host,
    port: Number(connection.port || 3306),
    user: connection.user,
    password: connection.password || '',
    database: database || connection.database,
    ssl: resolveMysqlSsl(connection.sslMode),
    dateStrings: true,
    decimalNumbers: false,
  };
}

function resolveMysqlSsl(mode) {
  const input = String(mode || 'PREFERRED').toUpperCase();
  if (input === 'DISABLED') return undefined;
  if (input === 'VERIFY_CA' || input === 'VERIFY_IDENTITY') return { rejectUnauthorized: true };
  return {};
}

async function startConsistentRead(conn, connection) {
  const consistentRead = connection?.consistentRead;
  if (!consistentRead?.enabled) return;
  const isolation = String(consistentRead.isolation || 'REPEATABLE READ').toUpperCase();
  await conn.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${isolation}`);
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
}

async function withMysqlConnection(connection, fn, { database } = {}) {
  const conn = await mysql.createConnection(buildMysqlConnectionConfig(connection, { database }));
  try {
    await startConsistentRead(conn, connection);
    return await fn(conn);
  } finally {
    if (connection?.consistentRead?.enabled) {
      try {
        await conn.query('COMMIT');
      } catch {
        // ignore cleanup failure
      }
    }
    await conn.end();
  }
}

async function openMysqlReadSession(connection, { database } = {}) {
  const conn = await mysql.createConnection(buildMysqlConnectionConfig(connection, { database }));
  await startConsistentRead(conn, connection);
  return {
    connection,
    database: database || connection.database,
    conn,
    consistencyMode: connection?.consistentRead?.enabled ? 'table-snapshot' : 'best-effort',
    startedAt: new Date().toISOString(),
  };
}

async function closeMysqlReadSession(session) {
  if (!session?.conn) return;
  try {
    if (session?.connection?.consistentRead?.enabled) {
      try {
        await session.conn.query('COMMIT');
      } catch {
        // ignore cleanup failure
      }
    }
  } finally {
    await session.conn.end();
  }
}

async function runMysqlQuery(connection, sql, params = [], { database } = {}) {
  return withMysqlConnection(connection, async (conn) => {
    const [rows] = await conn.query(sql, params);
    return rows;
  }, { database });
}

async function runMysqlSessionQuery(session, sql, params = []) {
  const [rows] = await session.conn.query(sql, params);
  return rows;
}

async function listMysqlSchemas(connection) {
  const rows = await runMysqlQuery(connection, `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY schema_name`);
  return rows.map((row) => row.schema_name);
}

function normalizeBooleanish(column) {
  return /tinyint\(1\)/i.test(column.fullType || '') || /boolean/i.test(column.dataType || '');
}

async function introspectMysqlSchema(connection, { schema, includeViews = false }) {
  const safeSchema = String(schema || connection.database);
  const tablesRows = await runMysqlQuery(connection, `
    SELECT table_name, table_type, engine, table_rows, table_collation, table_comment
    FROM information_schema.tables
    WHERE table_schema = ?
    ORDER BY table_name
  `, [safeSchema]);
  const columnsRows = await runMysqlQuery(connection, `
    SELECT table_name, ordinal_position, column_name, column_type, data_type, is_nullable, column_default,
           extra, column_key, character_set_name, collation_name, column_comment, generation_expression
    FROM information_schema.columns
    WHERE table_schema = ?
    ORDER BY table_name, ordinal_position
  `, [safeSchema]);
  const statsRows = await runMysqlQuery(connection, `
    SELECT table_name, index_name, non_unique, seq_in_index, column_name, sub_part, index_type
    FROM information_schema.statistics
    WHERE table_schema = ?
    ORDER BY table_name, index_name, seq_in_index
  `, [safeSchema]);
  const fkRows = await runMysqlQuery(connection, `
    SELECT kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.ordinal_position,
           kcu.referenced_table_name, kcu.referenced_column_name,
           rc.update_rule, rc.delete_rule
    FROM information_schema.key_column_usage kcu
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = kcu.constraint_schema
     AND rc.table_name = kcu.table_name
     AND rc.constraint_name = kcu.constraint_name
    WHERE kcu.table_schema = ?
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position
  `, [safeSchema]);

  const tables = tablesRows.map((row) => ({
    name: row.table_name,
    type: row.table_type === 'VIEW' ? 'view' : 'table',
    engine: row.engine || null,
    rowEstimate: Number(row.table_rows || 0),
    collation: row.table_collation || null,
    comment: row.table_comment || '',
  })).filter((table) => includeViews || table.type === 'table');

  const columnsByTable = new Map();
  for (const row of columnsRows) {
    const item = {
      table: row.table_name,
      ordinal: Number(row.ordinal_position),
      name: row.column_name,
      fullType: row.column_type,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default ?? null,
      extra: row.extra || '',
      key: row.column_key || '',
      charset: row.character_set_name || null,
      collation: row.collation_name || null,
      comment: row.column_comment || '',
      generationExpression: row.generation_expression || '',
    };
    item.autoIncrement = /auto_increment/i.test(item.extra);
    item.generated = /generated/i.test(item.extra) || Boolean(item.generationExpression);
    item.invisible = /invisible/i.test(item.extra);
    item.booleanish = normalizeBooleanish(item);
    if (!columnsByTable.has(item.table)) columnsByTable.set(item.table, []);
    columnsByTable.get(item.table).push(item);
  }

  const indexesByTable = new Map();
  for (const row of statsRows) {
    const entry = {
      table: row.table_name,
      name: row.index_name,
      unique: Number(row.non_unique) === 0,
      seq: Number(row.seq_in_index || 0),
      column: row.column_name,
      subPart: row.sub_part || null,
      type: row.index_type || 'BTREE',
    };
    if (!indexesByTable.has(entry.table)) indexesByTable.set(entry.table, []);
    indexesByTable.get(entry.table).push(entry);
  }

  const fksByTable = new Map();
  for (const row of fkRows) {
    const entry = {
      table: row.table_name,
      name: row.constraint_name,
      column: row.column_name,
      ordinal: Number(row.ordinal_position || 0),
      referencedTable: row.referenced_table_name,
      referencedColumn: row.referenced_column_name,
      updateRule: row.update_rule || 'NO ACTION',
      deleteRule: row.delete_rule || 'NO ACTION',
    };
    if (!fksByTable.has(entry.table)) fksByTable.set(entry.table, []);
    fksByTable.get(entry.table).push(entry);
  }

  const catalogTables = tables.map((table) => {
    const columns = columnsByTable.get(table.name) || [];
    const indexes = indexesByTable.get(table.name) || [];
    const pk = columns.filter((col) => col.key === 'PRI').map((col) => col.name);
    const foreignKeys = fksByTable.get(table.name) || [];
    const uniqueKeys = Array.from(new Set(indexes.filter((idx) => idx.unique && idx.name !== 'PRIMARY').map((idx) => idx.name))).map((name) => ({
      name,
      columns: indexes.filter((idx) => idx.name === name).sort((a, b) => a.seq - b.seq).map((idx) => idx.column),
    }));
    return {
      name: table.name,
      kind: table.type,
      engine: table.engine,
      rowEstimate: table.rowEstimate,
      collation: table.collation,
      comment: table.comment,
      primaryKey: pk,
      uniqueKeys,
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
      accessMode: 'mysql2-driver',
    },
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(catalogTables)).digest('hex'),
  };
  return metadata;
}

function normalizeMysqlRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) out[key] = value;
    else if (value instanceof Date) out[key] = value.toISOString();
    else out[key] = value;
  }
  return out;
}

function compareCursorValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const av = String(a);
  const bv = String(b);
  if (av === bv) return 0;
  return av > bv ? 1 : -1;
}

async function sampleMysqlTableRows(connection, schema, tableName, limit = 5) {
  return fetchMysqlRowsPage(connection, schema, tableName, { limit });
}

function buildFetchSql({ schema, tableName, columns = ['*'], limit = 500, offset = 0, keyset }) {
  const safeSchema = String(schema).replace(/`/g, '``');
  const safeTable = String(tableName || '').replace(/`/g, '``');
  const selected = Array.isArray(columns) && columns.length && !columns.includes('*')
    ? columns.map((column) => `\`${String(column).replace(/`/g, '``')}\``).join(', ')
    : '*';

  let sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` LIMIT ? OFFSET ?`;
  let params = [Math.max(1, Number(limit) || 500), Math.max(0, Number(offset) || 0)];

  if (keyset?.column) {
    const keyColumn = `\`${String(keyset.column).replace(/`/g, '``')}\``;
    if (keyset.lastValue == null) {
      sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` ORDER BY ${keyColumn} ASC LIMIT ?`;
      params = [Math.max(1, Number(limit) || 500)];
    } else {
      sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` WHERE ${keyColumn} > ? ORDER BY ${keyColumn} ASC LIMIT ?`;
      params = [keyset.lastValue, Math.max(1, Number(limit) || 500)];
    }
  }

  if (keyset?.watermarkColumn && keyset?.watermarkValue != null) {
    const watermarkColumn = `\`${String(keyset.watermarkColumn).replace(/`/g, '``')}\``;
    const tieBreakerColumn = keyset.tieBreakerColumn ? `\`${String(keyset.tieBreakerColumn).replace(/`/g, '``')}\`` : null;
    if (tieBreakerColumn && keyset.tieBreakerValue != null) {
      sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` WHERE (${watermarkColumn} > ?) OR (${watermarkColumn} = ? AND ${tieBreakerColumn} > ?) ORDER BY ${watermarkColumn} ASC, ${tieBreakerColumn} ASC LIMIT ?`;
      params = [keyset.watermarkValue, keyset.watermarkValue, keyset.tieBreakerValue, Math.max(1, Number(limit) || 500)];
    } else {
      sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` WHERE ${watermarkColumn} > ? ORDER BY ${watermarkColumn} ASC LIMIT ?`;
      params = [keyset.watermarkValue, Math.max(1, Number(limit) || 500)];
    }
  }

  return { sql, params };
}

async function fetchMysqlRowsPage(connection, schema, tableName, { columns = ['*'], limit = 500, offset = 0, keyset } = {}) {
  const query = buildFetchSql({ schema: String(schema || connection.database), tableName, columns, limit, offset, keyset });
  const rows = await runMysqlQuery(connection, query.sql, query.params);
  return rows.map(normalizeMysqlRow);
}

async function fetchMysqlRowsPageFromSession(session, schema, tableName, { columns = ['*'], limit = 500, offset = 0, keyset } = {}) {
  const query = buildFetchSql({ schema: String(schema || session.database), tableName, columns, limit, offset, keyset });
  const rows = await runMysqlSessionQuery(session, query.sql, query.params);
  return rows.map(normalizeMysqlRow);
}

async function countMysqlRows(connection, schema, tableName) {
  const safeSchema = String(schema || connection.database).replace(/`/g, '``');
  const safeTable = String(tableName || '').replace(/`/g, '``');
  const rows = await runMysqlQuery(connection, `SELECT COUNT(*) AS count FROM \`${safeSchema}\`.\`${safeTable}\``);
  return Number(rows?.[0]?.count || 0);
}

module.exports = {
  listMysqlSchemas,
  introspectMysqlSchema,
  sampleMysqlTableRows,
  runMysqlQuery,
  fetchMysqlRowsPage,
  fetchMysqlRowsPageFromSession,
  countMysqlRows,
  withMysqlConnection,
  openMysqlReadSession,
  closeMysqlReadSession,
  compareCursorValues,
};