const { requireToolDep } = require('../../requireToolDep');
const { Client } = requireToolDep('pg');
const crypto = require('node:crypto');

function buildPostgresConnectionString(connection) {
  if (String(connection.connectionString || '').trim()) return String(connection.connectionString || '').trim();
  const pooler = connection.pooler || {};
  const password = String(pooler.password || '');
  return `postgresql://${encodeURIComponent(pooler.user)}:${encodeURIComponent(password)}@${pooler.host}:${Number(pooler.port || 5432)}/${encodeURIComponent(pooler.database)}?sslmode=${encodeURIComponent(pooler.sslmode || 'require')}`;
}

async function withClient(connection, fn) {
  const client = new Client({ connectionString: buildPostgresConnectionString(connection) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function listPostgresSchemas(connection) {
  return withClient(connection, async (client) => {
    const result = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname`);
    return result.rows.map((row) => row.nspname);
  });
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

    const tables = tablesResult.rows
      .map((row) => ({
        name: row.table_name,
        kind: row.kind,
        rowEstimate: Number(row.row_estimate || 0),
        comment: row.comment || '',
        columns: columnsByTable.get(row.table_name) || [],
        indexes: indexesByTable.get(row.table_name) || [],
        foreignKeys: fksByTable.get(row.table_name) || [],
      }))
      .filter((table) => includeViews || table.kind === 'table')
      .map((table) => ({
        ...table,
        primaryKey: table.indexes.filter((index) => index.primary).map((index) => index.name),
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

module.exports = { buildPostgresConnectionString, listPostgresSchemas, introspectPostgresSchema, samplePostgresTableRows };