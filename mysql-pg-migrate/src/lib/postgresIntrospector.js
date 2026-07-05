const { requireToolDep } = require('../../requireToolDep');
const { Client, Pool } = requireToolDep('pg');
const crypto = require('node:crypto');
const { buildInsertSql, qualifyTable, buildCreateTableSql, buildAlterTableAddColumnsSql, buildAlterTableAddConstraintSql, quoteIdentifier } = require('./sql');
const {
  mapMysqlColumnToPostgres: mapMysqlColumnToPostgresByCatalog,
  compareMysqlToPostgresColumn: compareMysqlToPostgresColumnByCatalog,
} = require('./typeCompatibility');

const MASKED_CONNECTION_STRING = '[provided]';

function normalizeSslMode(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return 'prefer';
  if (['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(value)) return value;
  if (value === 'verify_ca') return 'verify-ca';
  if (value === 'verify_full') return 'verify-full';
  return 'prefer';
}

function resolvePgSslConfig(connection) {
  const mode = normalizeSslMode(connection?.pooler?.sslmode);
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

function buildPostgresClientConfig(connection) {
  const connectionString = buildPostgresConnectionString(connection);
  const ssl = resolvePgSslConfig(connection);
  return ssl ? { connectionString, ssl } : { connectionString };
}

function buildPostgresConnectionString(connection) {
  const inlineConnectionString = String(connection.connectionString || '').trim();
  if (inlineConnectionString && inlineConnectionString !== MASKED_CONNECTION_STRING) return inlineConnectionString;
  const pooler = connection.pooler || {};
  const password = String(pooler.password || '');
  return `postgresql://${encodeURIComponent(pooler.user)}:${encodeURIComponent(password)}@${pooler.host}:${Number(pooler.port || 5432)}/${encodeURIComponent(pooler.database)}?sslmode=${encodeURIComponent(normalizeSslMode(pooler.sslmode))}`;
}

async function withClient(connection, fn) {
  const client = new Client(buildPostgresClientConfig(connection));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const MAX_POOL_CACHE_SIZE = 20;
const poolCache = new Map();

function getPool(connection) {
  const connectionString = buildPostgresConnectionString(connection);
  const cached = poolCache.get(connectionString);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.pool;
  }
  const pool = new Pool({ ...buildPostgresClientConfig(connection), max: 10, idleTimeoutMillis: 30000 });
  poolCache.set(connectionString, { pool, lastUsedAt: Date.now() });
  if (poolCache.size > MAX_POOL_CACHE_SIZE) {
    const [oldestKey, oldest] = Array.from(poolCache.entries()).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0] || [];
    if (oldestKey) {
      poolCache.delete(oldestKey);
      oldest.pool.end().catch(() => {});
    }
  }
  return pool;
}

async function closePostgresPools() {
  const pools = Array.from(poolCache.values()).map((entry) => entry.pool);
  poolCache.clear();
  await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
}

async function withPooledClient(connection, fn) {
  const pool = getPool(connection);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function listPostgresSchemas(connection) {
  return withClient(connection, async (client) => {
    const result = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname`);
    return result.rows.map((row) => row.nspname);
  });
}

async function getExactPostgresRowCounts(client, schema, tables = []) {
  const counts = new Map();
  for (const table of tables) {
    try {
      const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${qualifyTable(schema, table.name)}`);
      counts.set(table.name, String(result.rows?.[0]?.count ?? '0'));
    } catch {
      counts.set(table.name, null);
    }
  }
  return counts;
}

async function introspectPostgresSchema(connection, { schema, includeViews = false }) {
  return withClient(connection, async (client) => {
    const safeSchema = String(schema || 'public');
    const tablesResult = await client.query(`
      SELECT c.relname AS table_name,
             CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
             c.reltuples::bigint AS row_estimate,
             pg_catalog.obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r','p','v','m')
      ORDER BY c.relname;
    `, [safeSchema]);

    const columnsResult = await client.query(`
      SELECT c.relname AS table_name,
             a.attnum AS ordinal,
             a.attname AS column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS full_type,
             t.typname AS data_type,
             NOT a.attnotnull AS nullable,
             pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
             a.attidentity AS identity_flag,
             a.attgenerated AS generated_flag,
             col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum;
    `, [safeSchema]);

    const indexesResult = await client.query(`
      SELECT tab.relname AS table_name,
             idx.relname AS index_name,
             ind.indisunique AS is_unique,
             ind.indisprimary AS is_primary,
             pg_get_indexdef(ind.indexrelid) AS definition
      FROM pg_index ind
      JOIN pg_class idx ON idx.oid = ind.indexrelid
      JOIN pg_class tab ON tab.oid = ind.indrelid
      JOIN pg_namespace n ON n.oid = tab.relnamespace
      WHERE n.nspname = $1
      ORDER BY tab.relname, idx.relname;
    `, [safeSchema]);

    const keyResult = await client.query(`
      SELECT tc.table_name,
             tc.constraint_name,
             tc.constraint_type,
             kcu.column_name,
             kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_schema = kcu.constraint_schema
       AND tc.table_name = kcu.table_name
       AND tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = $1
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
    `, [safeSchema]);

    const fkResult = await client.query(`
      SELECT src.relname AS table_name,
             con.conname AS constraint_name,
             src_col.attname AS column_name,
             dst.relname AS referenced_table,
             dst_col.attname AS referenced_column,
             con.confupdtype::text AS update_rule,
             con.confdeltype::text AS delete_rule
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      JOIN pg_class dst ON dst.oid = con.confrelid
      JOIN unnest(con.conkey) WITH ORDINALITY AS src_keys(attnum, ordinality) ON TRUE
      JOIN unnest(con.confkey) WITH ORDINALITY AS dst_keys(attnum, ordinality) ON dst_keys.ordinality = src_keys.ordinality
      JOIN pg_attribute src_col ON src_col.attrelid = src.oid AND src_col.attnum = src_keys.attnum
      JOIN pg_attribute dst_col ON dst_col.attrelid = dst.oid AND dst_col.attnum = dst_keys.attnum
      WHERE n.nspname = $1
        AND con.contype = 'f'
      ORDER BY src.relname, con.conname, src_keys.ordinality;
    `, [safeSchema]);

    const columnsByTable = new Map();
    for (const row of columnsResult.rows) {
      const item = {
        name: row.column_name,
        ordinal: Number(row.ordinal || 0),
        fullType: row.full_type,
        dataType: row.data_type,
        nullable: Boolean(row.nullable),
        defaultValue: row.default_value || null,
        identity: row.identity_flag || '',
        generated: row.generated_flag || '',
        comment: row.comment || '',
      };
      if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, []);
      columnsByTable.get(row.table_name).push(item);
    }

    const indexesByTable = new Map();
    for (const row of indexesResult.rows) {
      const entry = {
        name: row.index_name,
        unique: Boolean(row.is_unique),
        primary: Boolean(row.is_primary),
        definition: row.definition,
      };
      if (!indexesByTable.has(row.table_name)) indexesByTable.set(row.table_name, []);
      indexesByTable.get(row.table_name).push(entry);
    }

    const fksByTable = new Map();
    for (const row of fkResult.rows) {
      const entry = {
        name: row.constraint_name,
        column: row.column_name,
        referencedTable: row.referenced_table,
        referencedColumn: row.referenced_column,
        updateRule: row.update_rule,
        deleteRule: row.delete_rule,
      };
      if (!fksByTable.has(row.table_name)) fksByTable.set(row.table_name, []);
      fksByTable.get(row.table_name).push(entry);
    }

    const keysByTable = new Map();
    for (const row of keyResult.rows) {
      const tableKeys = keysByTable.get(row.table_name) || [];
      let key = tableKeys.find((item) => item.name === row.constraint_name);
      if (!key) {
        key = {
          name: row.constraint_name,
          type: row.constraint_type,
          columns: [],
        };
        tableKeys.push(key);
        keysByTable.set(row.table_name, tableKeys);
      }
      key.columns.push({ name: row.column_name, ordinal: Number(row.ordinal_position || 0) });
    }

    const baseTables = tablesResult.rows
      .map((row) => ({
        name: row.table_name,
        kind: row.kind,
        rowEstimate: Math.max(0, Number(row.row_estimate || 0)),
        comment: row.comment || '',
        columns: columnsByTable.get(row.table_name) || [],
        indexes: indexesByTable.get(row.table_name) || [],
        foreignKeys: fksByTable.get(row.table_name) || [],
      }))
      .filter((table) => includeViews || table.kind === 'table');
    const exactRowCounts = await getExactPostgresRowCounts(client, safeSchema, baseTables);
    const tables = baseTables
      .map((table) => ({
        ...table,
        rows: exactRowCounts.get(table.name) ?? String(table.rowEstimate),
        rowCountExact: exactRowCounts.get(table.name),
        primaryKey: (keysByTable.get(table.name) || [])
          .filter((key) => key.type === 'PRIMARY KEY')
          .flatMap((key) => key.columns.sort((a, b) => a.ordinal - b.ordinal).map((column) => column.name)),
        uniqueKeys: (keysByTable.get(table.name) || [])
          .filter((key) => key.type === 'UNIQUE')
          .map((key) => ({
            name: key.name,
            columns: key.columns.sort((a, b) => a.ordinal - b.ordinal).map((column) => column.name),
          })),
      }));

    return {
      engine: 'postgres',
      schema: safeSchema,
      tables,
      capabilities: {
        includeViews,
        sampledAt: new Date().toISOString(),
      },
      fingerprint: crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    };
  });
}

async function samplePostgresTableRows(connection, schema, tableName, limit = 5) {
  return withClient(connection, async (client) => {
    const safeSchema = String(schema || 'public').replace(/"/g, '');
    const safeTable = String(tableName || '').replace(/"/g, '');
    const result = await client.query(`SELECT row_to_json(t) AS data FROM (SELECT * FROM "${safeSchema}"."${safeTable}" LIMIT ${Math.max(1, Number(limit) || 5)}) t;`);
    return result.rows.map((row) => row.data);
  });
}

async function truncatePostgresTable(connection, schema, tableName) {
  return withClient(connection, async (client) => {
    await client.query(`TRUNCATE TABLE ${qualifyTable(schema, tableName)}`);
  });
}

async function writeRowsToPostgres(connection, { schema, tableName, rows, mode = 'append', conflictKeys = [] }) {
  if (!rows.length) return { rowCount: 0 };
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const filteredRows = rows.map((row) => {
    const next = {};
    for (const column of columns) next[column] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
    return next;
  });
  return withPooledClient(connection, async (client) => {
    const { sql, values } = buildInsertSql({ schema, table: tableName, columns, rows: filteredRows, conflictKeys, mode, updateColumns: columns.filter((column) => !conflictKeys.includes(column)) });
    const result = await client.query(sql, values);
    return { rowCount: result.rowCount ?? filteredRows.length };
  });
}

async function writeBatchedRowsToPostgres(connection, { schema, tableName, rows, mode = 'append', conflictKeys = [], batchSize = 1000 }) {
  const size = Math.max(1, Number(batchSize) || 1000);
  let rowCount = 0;
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    const result = await writeRowsToPostgres(connection, { schema, tableName, rows: chunk, mode, conflictKeys });
    rowCount += result.rowCount || chunk.length;
  }
  return { rowCount };
}

function normalizePgTypeForCompare(type) {
  return String(type || '')
    .toLowerCase()
    .replace(/character varying/g, 'varchar')
    .replace(/timestamp with time zone/g, 'timestamptz')
    .replace(/timestamp without time zone/g, 'timestamp')
    .replace(/double precision/g, 'float8')
    .replace(/boolean/g, 'bool')
    .replace(/integer/g, 'int4')
    .replace(/bigint/g, 'int8')
    .replace(/smallint/g, 'int2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMysqlDefaultExpression(defaultValue, pgType) {
  if (defaultValue == null) return null;
  const raw = String(defaultValue).trim();
  if (!raw || /^null$/i.test(raw)) return null;
  if (/^current_timestamp(\(\))?$/i.test(raw)) return 'CURRENT_TIMESTAMP';
  if (/^(current_date|curdate\(\))$/i.test(raw)) return 'CURRENT_DATE';
  if (/^(current_time|curtime\(\))$/i.test(raw)) return 'CURRENT_TIME';
  if (/^(now\(\))$/i.test(raw)) return 'CURRENT_TIMESTAMP';
  if (pgType === 'boolean') {
    if (['1', 'true'].includes(raw.toLowerCase())) return 'TRUE';
    if (['0', 'false'].includes(raw.toLowerCase())) return 'FALSE';
  }
  if (/^(integer|bigint|smallint|numeric|real|double precision)/.test(pgType) && /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  if (/^jsonb?$/.test(pgType)) return `'${raw.replace(/'/g, "''")}'::jsonb`;
  return `'${raw.replace(/'/g, "''")}'`;
}

function inferEnumValues(column) {
  const match = String(column?.fullType || '').match(/^enum\((.*)\)$/i);
  if (!match) return [];
  return match[1]
    .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((item) => item.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'"))
    .filter(Boolean);
}

function inferSetValues(column) {
  const match = String(column?.fullType || '').match(/^set\((.*)\)$/i);
  if (!match) return [];
  return match[1]
    .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((item) => item.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'"))
    .filter(Boolean);
}

function compareMysqlToPostgresColumn(sourceColumn, targetColumn) {
  const proposed = mapMysqlColumnToPostgres(sourceColumn);
  const comparison = compareMysqlToPostgresColumnByCatalog(sourceColumn, targetColumn);
  const defaultCompatible = !proposed.defaultExpression || !targetColumn?.defaultValue || normalizePgTypeForCompare(proposed.defaultExpression) === normalizePgTypeForCompare(targetColumn.defaultValue);
  return {
    ...comparison,
    compatible: Boolean(comparison.compatible),
    defaultCompatible,
    proposedDefault: proposed.defaultExpression,
    targetDefault: targetColumn?.defaultValue || null,
    enumValues: proposed.enumValues || [],
    setValues: proposed.setValues || [],
  };
}

function describeCompatibilityBlockers(columnName, comparison = {}) {
  const reasons = [];
  if (!comparison.compatibleType) {
    reasons.push(`type ${comparison.proposedType || 'unknown'} -> ${comparison.targetType || 'unknown'}`);
  }
  if (!comparison.nullableCompatible) {
    reasons.push('target is NOT NULL but source can contain NULL values');
  }
  return `Incompatible target column ${columnName}: ${reasons.join('; ') || 'manual schema review required'}`;
}

function mapMysqlColumnToPostgres(column = {}) {
  const mapped = mapMysqlColumnToPostgresByCatalog(column || {});
  const enumValues = inferEnumValues(column);
  const setValues = inferSetValues(column);
  let defaultExpression = null;

  if (!column.autoIncrement && !column.generated) {
    defaultExpression = normalizeMysqlDefaultExpression(column.defaultValue, mapped.pgType);
    if (/^jsonb$/i.test(mapped.pgType) && setValues.length && column.defaultValue) {
      const setItems = String(column.defaultValue)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      defaultExpression = `'${JSON.stringify(setItems).replace(/'/g, "''")}'::jsonb`;
    }
  }

  return {
    ...mapped,
    name: column.name,
    defaultExpression,
    enumValues,
    setValues,
  };
}

function buildProvisioningPlan({ sourceCatalog, targetCatalog, targetSchema, tableMappings }) {
  const targetTables = new Map((targetCatalog.tables || []).map((table) => [table.name, table]));
  const sourceTables = new Map((sourceCatalog.tables || []).map((table) => [table.name, table]));
  const mappingsBySource = new Map((tableMappings || []).filter((mapping) => mapping.enabled !== false).map((mapping) => [mapping.sourceTable, mapping]));

  const plan = (tableMappings || []).filter((mapping) => mapping.enabled !== false).map((mapping) => {
    const sourceTable = sourceTables.get(mapping.sourceTable);
    const targetTable = mapping.targetTable ? targetTables.get(mapping.targetTable) : null;
    const desiredTargetName = mapping.targetTable || mapping.sourceTable;
    const enabledMappings = (mapping.columnMappings || []).filter((item) => item.enabled !== false && item.targetColumnMode !== 'ignore' && item.targetColumn);
    const hasExplicitColumnMappings = (mapping.columnMappings || []).length > 0;
    const shouldCreate = !targetTable && (mapping.createTargetTable === true || mapping.targetTableMode === 'create_new');
    const sourceToTargetColumn = new Map();
    const desiredColumns = (sourceTable?.columns || [])
      .filter((column) => {
        if (shouldCreate && !hasExplicitColumnMappings) return true;
        return enabledMappings.some((item) => item.sourceColumn === column.name);
      })
      .map((column) => {
        const mapped = enabledMappings.find((item) => item.sourceColumn === column.name);
        const targetName = mapped?.targetColumn || column.name;
        sourceToTargetColumn.set(column.name, targetName);
        return { ...mapMysqlColumnToPostgres(column), name: targetName, sourceColumn: column.name };
      });
    const desiredColumnNames = new Set(desiredColumns.map((column) => column.name));
    function mapSourceColumnName(sourceColumn) {
      return sourceToTargetColumn.get(sourceColumn) || (hasExplicitColumnMappings ? null : sourceColumn);
    }
    function mapSourceColumns(sourceColumns = []) {
      const mapped = [];
      for (const sourceColumn of sourceColumns || []) {
        const targetColumn = mapSourceColumnName(sourceColumn);
        if (!targetColumn || !desiredColumnNames.has(targetColumn)) return null;
        mapped.push(targetColumn);
      }
      return mapped;
    }
    const primaryKey = mapSourceColumns(sourceTable?.primaryKey || []) || [];

    const targetColumns = new Map((targetTable?.columns || []).map((column) => [column.name, column]));
    const missingColumns = [];
    const compatibleColumns = [];
    const incompatibleColumns = [];
    const readiness = { level: 'ready', reasons: [] };
    const indexesToCreate = [];
    const constraintsToCreate = [];
    const enumPlans = [];

    for (const desiredColumn of desiredColumns) {
      const existingColumn = targetColumns.get(desiredColumn.name);
      if (!existingColumn) {
        missingColumns.push(desiredColumn);
        continue;
      }
      const sourceColumn = (sourceTable?.columns || []).find((column) => column.name === desiredColumn.sourceColumn);
      const comparison = compareMysqlToPostgresColumn(sourceColumn || desiredColumn, existingColumn);
      if (comparison.compatible) {
        const needsReview = !comparison.defaultCompatible || (comparison.reviewReasons || []).length > 0;
        compatibleColumns.push({ name: desiredColumn.name, comparison, state: needsReview ? 'compatible_with_review' : 'compatible', compatibilityClass: comparison.compatibilityClass || 'direct' });
        if (!comparison.defaultCompatible) {
          readiness.level = readiness.level === 'blocked' ? 'blocked' : 'review';
          readiness.reasons.push(`Default differs for column ${desiredColumn.name}`);
        }
        for (const reason of comparison.reviewReasons || []) {
          readiness.level = readiness.level === 'blocked' ? 'blocked' : 'review';
          readiness.reasons.push(`Review ${desiredColumn.name}: ${reason}`);
        }
      } else {
        incompatibleColumns.push({ name: desiredColumn.name, comparison, sourceColumn: desiredColumn.sourceColumn });
        readiness.level = 'blocked';
        readiness.reasons.push(describeCompatibilityBlockers(desiredColumn.name, comparison));
      }
    }

    let action = 'use_existing';
    let ddl = null;
    const issues = [];

    if (!targetTable && !shouldCreate) {
      action = 'missing_target_table';
      issues.push({ kind: 'missing_target_table', message: `Target table ${desiredTargetName} does not exist` });
      readiness.level = 'blocked';
      readiness.reasons.push('Target table does not exist');
    } else if (!targetTable && shouldCreate) {
      action = 'create_table';
      ddl = buildCreateTableSql({ schema: targetSchema, table: desiredTargetName, columns: desiredColumns, primaryKey });
      for (const desiredColumn of desiredColumns) {
        if (desiredColumn.enumValues?.length) {
          enumPlans.push({ column: desiredColumn.name, values: desiredColumn.enumValues, strategy: 'text-check-or-native-enum-later' });
        }
      }
      const sourceIndexes = sourceTable?.indexes || [];
      const seenIndexNames = new Set();
      const uniqueKeySignatures = new Set((sourceTable?.uniqueKeys || []).map((key) => (key.columns || []).join('\u0000')));
      for (const index of sourceIndexes) {
        if (index.name === 'PRIMARY') continue;
        if (seenIndexNames.has(index.name)) continue;
        seenIndexNames.add(index.name);
        const sourceIndexColumns = sourceIndexes.filter((item) => item.name === index.name).sort((a, b) => a.seq - b.seq).map((item) => item.column);
        if (index.unique && uniqueKeySignatures.has(sourceIndexColumns.join('\u0000'))) continue;
        const mappedIndexColumns = mapSourceColumns(sourceIndexColumns);
        if (!mappedIndexColumns?.length) continue;
        indexesToCreate.push({
          name: `${desiredTargetName}_${index.name}`,
          unique: Boolean(index.unique),
          columns: mappedIndexColumns,
        });
      }
      for (const key of sourceTable?.uniqueKeys || []) {
        const mappedColumns = mapSourceColumns(key.columns || []);
        if (mappedColumns?.length) {
          constraintsToCreate.push({
            type: 'unique',
            name: `${desiredTargetName}_${key.name}`,
            columns: mappedColumns,
            autoApplySafe: true,
          });
        }
      }
      for (const fk of sourceTable?.foreignKeys || []) {
        const mappedColumn = mapSourceColumnName(fk.column);
        const referencedMapping = mappingsBySource.get(fk.referencedTable);
        const referencedTargetTable = referencedMapping?.targetTable || fk.referencedTable;
        const referencedTargetColumn = (referencedMapping?.columnMappings || []).find((item) => item.enabled !== false && item.targetColumnMode !== 'ignore' && item.sourceColumn === fk.referencedColumn)?.targetColumn || fk.referencedColumn;
        if (!mappedColumn) continue;
        constraintsToCreate.push({
          type: 'foreign_key',
          name: `${desiredTargetName}_${fk.name}`,
          columns: [mappedColumn],
          references: { table: referencedTargetTable, columns: [referencedTargetColumn] },
          autoApplySafe: false,
          reason: 'requires referenced table/column parity verification',
        });
      }
      readiness.level = 'provision';
      readiness.reasons.push('Target table will be created');
    } else if (targetTable && mapping.targetTableMode === 'create_new' && desiredTargetName === targetTable.name) {
      action = 'target_name_conflict';
      issues.push({ kind: 'target_name_conflict', message: `Target table ${desiredTargetName} already exists but mapping is marked create_new` });
      readiness.level = 'blocked';
      readiness.reasons.push('Target name conflicts with existing table');
    } else if (incompatibleColumns.length) {
      action = 'manual_fix_required';
      issues.push(...incompatibleColumns.map((column) => ({
        kind: 'incompatible_target_column',
        column: column.name,
        sourceColumn: column.sourceColumn,
        message: describeCompatibilityBlockers(column.name, column.comparison),
        comparison: column.comparison,
      })));
      readiness.level = 'blocked';
    } else if (missingColumns.length) {
      action = 'alter_table_add_columns';
      ddl = buildAlterTableAddColumnsSql({ schema: targetSchema, table: desiredTargetName, columns: missingColumns });
      readiness.level = 'provision';
      readiness.reasons.push('Missing columns will be added');
      for (const column of missingColumns) {
        if (!column.nullable && !column.defaultExpression && !column.identity && !column.generated) {
          issues.push({
            kind: 'not_null_column_added_nullable',
            column: column.name,
            message: `Column ${column.name} is NOT NULL in MySQL but will be added nullable first; backfill and add NOT NULL manually if required.`,
          });
          readiness.reasons.push(`Backfill/re-apply NOT NULL manually for ${column.name}`);
        }
      }
    }

    const ddlStatements = [ddl, ...buildAlterTableAddConstraintSql({ schema: targetSchema, table: desiredTargetName, constraints: constraintsToCreate.filter((item) => item.autoApplySafe) })].filter(Boolean);

    return {
      sourceTable: mapping.sourceTable,
      targetTable: desiredTargetName,
      exists: Boolean(targetTable),
      action,
      columns: desiredColumns,
      primaryKey,
      indexesToCreate,
      constraintsToCreate,
      enumPlans,
      missingColumns,
      compatibleColumns,
      incompatibleColumns,
      issues,
      ddl,
      ddlStatements,
      readiness,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    targetSchema,
    tables: plan,
    summary: {
      createTableCount: plan.filter((item) => item.action === 'create_table').length,
      alterTableCount: plan.filter((item) => item.action === 'alter_table_add_columns').length,
      existingTableCount: plan.filter((item) => item.action === 'use_existing').length,
      incompatibleTableCount: plan.filter((item) => item.action === 'manual_fix_required' || item.action === 'target_name_conflict' || item.action === 'missing_target_table').length,
    },
  };
}

async function createTargetTables(connection, { schema, tables }) {
  return withClient(connection, async (client) => {
    const results = [];
    for (const table of tables || []) {
      if (!['create_table', 'alter_table_add_columns'].includes(table.action) || !(table.ddlStatements?.length || table.ddl)) continue;
      for (const statement of (table.ddlStatements?.length ? table.ddlStatements : [table.ddl])) {
        await client.query(statement);
      }
      for (const index of table.indexesToCreate || []) {
        if (!index.columns?.length) continue;
        const sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${qualifyTable(schema, table.targetTable)} (${index.columns.map(quoteIdentifier).join(', ')})`;
        await client.query(sql);
      }
      results.push({ table: table.targetTable, status: table.action === 'create_table' ? 'created' : 'altered' });
    }
    return results;
  });
}

async function countPostgresRows(connection, schema, tableName) {
  return withClient(connection, async (client) => {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${qualifyTable(schema, tableName)}`);
    return Number(result.rows?.[0]?.count || 0);
  });
}

module.exports = { buildPostgresConnectionString, buildPostgresClientConfig, listPostgresSchemas, introspectPostgresSchema, samplePostgresTableRows, truncatePostgresTable, writeRowsToPostgres, writeBatchedRowsToPostgres, withClient, withPooledClient, mapMysqlColumnToPostgres, buildProvisioningPlan, createTargetTables, compareMysqlToPostgresColumn, countPostgresRows, normalizeSslMode, resolvePgSslConfig, closePostgresPools };
