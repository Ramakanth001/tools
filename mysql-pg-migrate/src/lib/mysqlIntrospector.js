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
  if (input === 'DISABLED' || input === 'PREFERRED') return undefined;
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
  const rows = await runMysqlQuery(connection, `SELECT SCHEMA_NAME AS schemaName FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME`);
  return rows.map((row) => pickMysqlValue(row, ['schemaName', 'schema_name', 'SCHEMA_NAME'])).map((value) => String(value || '').trim()).filter(Boolean);
}

function pickMysqlValue(row, keys, fallback = null) {
  if (!row || typeof row !== 'object') return fallback;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  const lowerLookup = new Map(Object.keys(row).map((key) => [String(key).toLowerCase(), key]));
  for (const key of keys) {
    const actual = lowerLookup.get(String(key).toLowerCase());
    if (actual && Object.prototype.hasOwnProperty.call(row, actual)) return row[actual];
  }
  return fallback;
}

function normalizeBooleanish(column) {
  return /tinyint\(1\)/i.test(column.fullType || '') || /boolean/i.test(column.dataType || '');
}

async function introspectMysqlSchema(connection, { schema, includeViews = false }) {
  const safeSchema = String(schema || connection.database);
  const tablesRows = await runMysqlQuery(connection, `
    SELECT TABLE_NAME AS tableName,
           TABLE_TYPE AS tableType,
           ENGINE AS engine,
           TABLE_ROWS AS tableRows,
           TABLE_COLLATION AS tableCollation,
           TABLE_COMMENT AS tableComment
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME
  `, [safeSchema]);
  const columnsRows = await runMysqlQuery(connection, `
    SELECT TABLE_NAME AS tableName,
           ORDINAL_POSITION AS ordinalPosition,
           COLUMN_NAME AS columnName,
           COLUMN_TYPE AS columnType,
           DATA_TYPE AS dataType,
           IS_NULLABLE AS isNullable,
           COLUMN_DEFAULT AS columnDefault,
           EXTRA AS extra,
           COLUMN_KEY AS columnKey,
           CHARACTER_SET_NAME AS characterSetName,
           COLLATION_NAME AS collationName,
           COLUMN_COMMENT AS columnComment,
           GENERATION_EXPRESSION AS generationExpression
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `, [safeSchema]);
  const statsRows = await runMysqlQuery(connection, `
    SELECT TABLE_NAME AS tableName,
           INDEX_NAME AS indexName,
           NON_UNIQUE AS nonUnique,
           SEQ_IN_INDEX AS seqInIndex,
           COLUMN_NAME AS columnName,
           SUB_PART AS subPart,
           INDEX_TYPE AS indexType
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `, [safeSchema]);
  const fkRows = await runMysqlQuery(connection, `
    SELECT kcu.TABLE_NAME AS tableName,
           kcu.CONSTRAINT_NAME AS constraintName,
           kcu.COLUMN_NAME AS columnName,
           kcu.ORDINAL_POSITION AS ordinalPosition,
           kcu.REFERENCED_TABLE_NAME AS referencedTableName,
           kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
           rc.UPDATE_RULE AS updateRule,
           rc.DELETE_RULE AS deleteRule
    FROM information_schema.KEY_COLUMN_USAGE kcu
    LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
     AND rc.TABLE_NAME = kcu.TABLE_NAME
     AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
    WHERE kcu.TABLE_SCHEMA = ?
      AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
  `, [safeSchema]);

  const tables = tablesRows.map((row) => ({
    name: String(pickMysqlValue(row, ['tableName', 'table_name', 'TABLE_NAME']) || '').trim(),
    type: pickMysqlValue(row, ['tableType', 'table_type', 'TABLE_TYPE']) === 'VIEW' ? 'view' : 'table',
    engine: pickMysqlValue(row, ['engine', 'ENGINE']) || null,
    rowEstimate: Number(pickMysqlValue(row, ['tableRows', 'table_rows', 'TABLE_ROWS']) || 0),
    collation: pickMysqlValue(row, ['tableCollation', 'table_collation', 'TABLE_COLLATION']) || null,
    comment: pickMysqlValue(row, ['tableComment', 'table_comment', 'TABLE_COMMENT']) || '',
  })).filter((table) => table.name && (includeViews || table.type === 'table'));

  const columnsByTable = new Map();
  for (const row of columnsRows) {
    const item = {
      table: String(pickMysqlValue(row, ['tableName', 'table_name', 'TABLE_NAME']) || '').trim(),
      ordinal: Number(pickMysqlValue(row, ['ordinalPosition', 'ordinal_position', 'ORDINAL_POSITION']) || 0),
      name: String(pickMysqlValue(row, ['columnName', 'column_name', 'COLUMN_NAME']) || '').trim(),
      fullType: pickMysqlValue(row, ['columnType', 'column_type', 'COLUMN_TYPE']) || '',
      dataType: pickMysqlValue(row, ['dataType', 'data_type', 'DATA_TYPE']) || '',
      nullable: pickMysqlValue(row, ['isNullable', 'is_nullable', 'IS_NULLABLE']) === 'YES',
      defaultValue: pickMysqlValue(row, ['columnDefault', 'column_default', 'COLUMN_DEFAULT']) ?? null,
      extra: pickMysqlValue(row, ['extra', 'EXTRA']) || '',
      key: pickMysqlValue(row, ['columnKey', 'column_key', 'COLUMN_KEY']) || '',
      charset: pickMysqlValue(row, ['characterSetName', 'character_set_name', 'CHARACTER_SET_NAME']) || null,
      collation: pickMysqlValue(row, ['collationName', 'collation_name', 'COLLATION_NAME']) || null,
      comment: pickMysqlValue(row, ['columnComment', 'column_comment', 'COLUMN_COMMENT']) || '',
      generationExpression: pickMysqlValue(row, ['generationExpression', 'generation_expression', 'GENERATION_EXPRESSION']) || '',
    };
    if (!item.table || !item.name) continue;
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
      table: String(pickMysqlValue(row, ['tableName', 'table_name', 'TABLE_NAME']) || '').trim(),
      name: String(pickMysqlValue(row, ['indexName', 'index_name', 'INDEX_NAME']) || '').trim(),
      unique: Number(pickMysqlValue(row, ['nonUnique', 'non_unique', 'NON_UNIQUE']) || 0) === 0,
      seq: Number(pickMysqlValue(row, ['seqInIndex', 'seq_in_index', 'SEQ_IN_INDEX']) || 0),
      column: String(pickMysqlValue(row, ['columnName', 'column_name', 'COLUMN_NAME']) || '').trim(),
      subPart: pickMysqlValue(row, ['subPart', 'sub_part', 'SUB_PART']) || null,
      type: pickMysqlValue(row, ['indexType', 'index_type', 'INDEX_TYPE']) || 'BTREE',
    };
    if (!entry.table || !entry.name || !entry.column) continue;
    if (!indexesByTable.has(entry.table)) indexesByTable.set(entry.table, []);
    indexesByTable.get(entry.table).push(entry);
  }

  const fksByTable = new Map();
  for (const row of fkRows) {
    const entry = {
      table: String(pickMysqlValue(row, ['tableName', 'table_name', 'TABLE_NAME']) || '').trim(),
      name: String(pickMysqlValue(row, ['constraintName', 'constraint_name', 'CONSTRAINT_NAME']) || '').trim(),
      column: String(pickMysqlValue(row, ['columnName', 'column_name', 'COLUMN_NAME']) || '').trim(),
      ordinal: Number(pickMysqlValue(row, ['ordinalPosition', 'ordinal_position', 'ORDINAL_POSITION']) || 0),
      referencedTable: String(pickMysqlValue(row, ['referencedTableName', 'referenced_table_name', 'REFERENCED_TABLE_NAME']) || '').trim(),
      referencedColumn: String(pickMysqlValue(row, ['referencedColumnName', 'referenced_column_name', 'REFERENCED_COLUMN_NAME']) || '').trim(),
      updateRule: pickMysqlValue(row, ['updateRule', 'update_rule', 'UPDATE_RULE']) || 'NO ACTION',
      deleteRule: pickMysqlValue(row, ['deleteRule', 'delete_rule', 'DELETE_RULE']) || 'NO ACTION',
    };
    if (!entry.table || !entry.name || !entry.column || !entry.referencedTable || !entry.referencedColumn) continue;
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
  const ai = typeof a === 'bigint' ? a : (typeof a === 'number' && Number.isInteger(a) ? BigInt(a) : (typeof a === 'string' && /^-?\d+$/.test(a.trim()) ? BigInt(a.trim()) : null));
  const bi = typeof b === 'bigint' ? b : (typeof b === 'number' && Number.isInteger(b) ? BigInt(b) : (typeof b === 'string' && /^-?\d+$/.test(b.trim()) ? BigInt(b.trim()) : null));
  if (ai != null && bi != null) {
    if (ai === bi) return 0;
    return ai > bi ? 1 : -1;
  }
  const an = typeof a === 'number' ? a : (typeof a === 'bigint' ? Number(a) : (typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a.trim()) ? Number(a) : NaN));
  const bn = typeof b === 'number' ? b : (typeof b === 'bigint' ? Number(b) : (typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b.trim()) ? Number(b) : NaN));
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    if (an === bn) return 0;
    return an > bn ? 1 : -1;
  }
  const av = String(a);
  const bv = String(b);
  if (av === bv) return 0;
  return av > bv ? 1 : -1;
}

function quoteMysqlIdentifier(name) {
  return `\`${String(name || '').replace(/`/g, '``')}\``;
}

function buildSourceFilter(filter) {
  if (!filter?.enabled || !filter.column) return { clause: '', params: [] };
  const column = quoteMysqlIdentifier(filter.column);
  const operator = String(filter.operator || '>=').toLowerCase();
  if (operator === 'is_null') return { clause: `${column} IS NULL`, params: [] };
  if (operator === 'is_not_null') return { clause: `${column} IS NOT NULL`, params: [] };
  if (operator === 'between') return { clause: `${column} BETWEEN ? AND ?`, params: [filter.value, filter.valueTo] };
  if (operator === 'like') return { clause: `${column} LIKE ?`, params: [filter.value] };
  const allowed = new Set(['=', '!=', '>', '>=', '<', '<=']);
  const op = allowed.has(operator) ? operator : '>=';
  return { clause: `${column} ${op} ?`, params: [filter.value] };
}

async function sampleMysqlTableRows(connection, schema, tableName, limit = 5, options = {}) {
  return fetchMysqlRowsPage(connection, schema, tableName, { limit, ...options });
}

function buildFetchSql({ schema, tableName, columns = ['*'], limit = 500, offset = 0, keyset, sourceFilter }) {
  const safeSchema = String(schema).replace(/`/g, '``');
  const safeTable = String(tableName || '').replace(/`/g, '``');
  const selected = Array.isArray(columns) && columns.length && !columns.includes('*')
    ? columns.map(quoteMysqlIdentifier).join(', ')
    : '*';

  const whereParts = [];
  const whereParams = [];
  const filter = buildSourceFilter(sourceFilter);
  if (filter.clause) {
    whereParts.push(filter.clause);
    whereParams.push(...filter.params);
  }

  let orderBy = '';
  let limitOffsetSql = 'LIMIT ? OFFSET ?';
  let cursorParams = [];

  if (keyset?.watermarkColumn) {
    const watermarkColumn = quoteMysqlIdentifier(keyset.watermarkColumn);
    const tieBreakerColumn = keyset.tieBreakerColumn ? quoteMysqlIdentifier(keyset.tieBreakerColumn) : null;
    if (keyset.watermarkValue != null) {
      if (tieBreakerColumn && keyset.tieBreakerValue != null) {
        whereParts.push(`(${watermarkColumn} > ? OR (${watermarkColumn} = ? AND ${tieBreakerColumn} > ?))`);
        cursorParams.push(keyset.watermarkValue, keyset.watermarkValue, keyset.tieBreakerValue);
      } else {
        whereParts.push(`${watermarkColumn} > ?`);
        cursorParams.push(keyset.watermarkValue);
      }
    }
    orderBy = tieBreakerColumn ? `ORDER BY ${watermarkColumn} ASC, ${tieBreakerColumn} ASC` : `ORDER BY ${watermarkColumn} ASC`;
    limitOffsetSql = 'LIMIT ?';
  } else if (keyset?.column) {
    const keyColumn = quoteMysqlIdentifier(keyset.column);
    if (keyset.lastValue == null) {
      orderBy = `ORDER BY ${keyColumn} ASC`;
      limitOffsetSql = 'LIMIT ?';
    } else {
      whereParts.push(`${keyColumn} > ?`);
      cursorParams.push(keyset.lastValue);
      orderBy = `ORDER BY ${keyColumn} ASC`;
      limitOffsetSql = 'LIMIT ?';
    }
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const sql = `SELECT ${selected} FROM \`${safeSchema}\`.\`${safeTable}\` ${whereSql} ${orderBy} ${limitOffsetSql}`.replace(/\s+/g, ' ').trim();
  const limitValue = Math.max(1, Number(limit) || 500);
  const params = limitOffsetSql === 'LIMIT ?'
    ? [...whereParams, ...cursorParams, limitValue]
    : [...whereParams, ...cursorParams, limitValue, Math.max(0, Number(offset) || 0)];

  return { sql, params };
}

async function fetchMysqlRowsPage(connection, schema, tableName, { columns = ['*'], limit = 500, offset = 0, keyset, sourceFilter } = {}) {
  const query = buildFetchSql({ schema: String(schema || connection.database), tableName, columns, limit, offset, keyset, sourceFilter });
  const rows = await runMysqlQuery(connection, query.sql, query.params);
  return rows.map(normalizeMysqlRow);
}

async function fetchMysqlRowsPageFromSession(session, schema, tableName, { columns = ['*'], limit = 500, offset = 0, keyset, sourceFilter } = {}) {
  const query = buildFetchSql({ schema: String(schema || session.database), tableName, columns, limit, offset, keyset, sourceFilter });
  const rows = await runMysqlSessionQuery(session, query.sql, query.params);
  return rows.map(normalizeMysqlRow);
}

async function countMysqlRows(connection, schema, tableName, { sourceFilter, keyset } = {}) {
  const safeSchema = String(schema || connection.database).replace(/`/g, '``');
  const safeTable = String(tableName || '').replace(/`/g, '``');
  const whereParts = [];
  const params = [];
  const filter = buildSourceFilter(sourceFilter);
  if (filter.clause) {
    whereParts.push(filter.clause);
    params.push(...filter.params);
  }
  if (keyset?.watermarkColumn && keyset.watermarkValue != null) {
    const watermarkColumn = quoteMysqlIdentifier(keyset.watermarkColumn);
    const tieBreakerColumn = keyset.tieBreakerColumn ? quoteMysqlIdentifier(keyset.tieBreakerColumn) : null;
    if (tieBreakerColumn && keyset.tieBreakerValue != null) {
      whereParts.push(`(${watermarkColumn} > ? OR (${watermarkColumn} = ? AND ${tieBreakerColumn} > ?))`);
      params.push(keyset.watermarkValue, keyset.watermarkValue, keyset.tieBreakerValue);
    } else {
      whereParts.push(`${watermarkColumn} > ?`);
      params.push(keyset.watermarkValue);
    }
  } else if (keyset?.column && keyset.lastValue != null) {
    whereParts.push(`${quoteMysqlIdentifier(keyset.column)} > ?`);
    params.push(keyset.lastValue);
  }
  const whereSql = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';
  const rows = await runMysqlQuery(connection, `SELECT COUNT(*) AS count FROM \`${safeSchema}\`.\`${safeTable}\`${whereSql}`, params);
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
