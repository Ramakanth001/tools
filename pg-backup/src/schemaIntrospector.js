const { spawn } = require('node:child_process');

function commandExists(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
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

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildSnapshotSql({ schemaInclude, schemaExclude, tableInclude, tableExclude } = {}) {
  const incSchemas = parseList(schemaInclude);
  const excSchemas = parseList(schemaExclude);
  const incTables = parseList(tableInclude); // schema.table
  const excTables = parseList(tableExclude);

  // We keep this conservative and human-auditable.
  // Filters are applied at the SQL layer to avoid huge payloads.
  const schemaFilter = `
    (n.nspname NOT IN ('pg_catalog','information_schema'))
    ${incSchemas.length ? `AND n.nspname = ANY(ARRAY[${incSchemas.map((s) => `'${s.replaceAll("'", "''")}'`).join(',')}])` : ''}
    ${excSchemas.length ? `AND n.nspname <> ALL(ARRAY[${excSchemas.map((s) => `'${s.replaceAll("'", "''")}'`).join(',')}])` : ''}
  `;

  // tables: schema-qualified matching.
  const tblQName = `(n.nspname || '.' || c.relname)`;
  const tableFilter = `
    ${incTables.length ? `AND ${tblQName} = ANY(ARRAY[${incTables.map((t) => `'${t.replaceAll("'", "''")}'`).join(',')}])` : ''}
    ${excTables.length ? `AND ${tblQName} <> ALL(ARRAY[${excTables.map((t) => `'${t.replaceAll("'", "''")}'`).join(',')}])` : ''}
  `;

  // Note: We intentionally return one JSON value.
  return `
WITH
params AS (
  SELECT
    current_database()::text AS db,
    now()::timestamptz AS captured_at
),
schemas AS (
  SELECT n.oid AS schema_oid, n.nspname AS schema_name
  FROM pg_namespace n
  WHERE ${schemaFilter}
),
tables AS (
  SELECT
    c.oid AS table_oid,
    n.nspname AS schema_name,
    c.relname AS table_name,
    c.relkind AS relkind,
    pg_total_relation_size(c.oid)::bigint AS total_bytes,
    pg_relation_size(c.oid)::bigint AS heap_bytes,
    COALESCE(s.n_live_tup, 0)::bigint AS est_rows,
    COALESCE(s.seq_scan, 0)::bigint AS seq_scan,
    COALESCE(s.idx_scan, 0)::bigint AS idx_scan
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.oid IN (SELECT schema_oid FROM schemas)
    AND c.relkind IN ('r','p','v','m','f')
    ${tableFilter}
),
columns AS (
  SELECT
    a.attrelid AS table_oid,
    a.attnum,
    a.attname AS column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    a.attnotnull AS not_null,
    pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
    a.attidentity::text AS identity,
    a.attgenerated::text AS generated,
    a.attisdropped AS dropped
  FROM pg_attribute a
  JOIN tables t ON t.table_oid = a.attrelid
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE a.attnum > 0
),
constraints AS (
  SELECT
    con.oid AS constraint_oid,
    con.conrelid AS table_oid,
    n.nspname AS schema_name,
    c.relname AS table_name,
    con.conname AS name,
    con.contype::text AS type,
    pg_get_constraintdef(con.oid, true) AS definition,
    con.confrelid AS ref_table_oid,
    (SELECT ARRAY_AGG(att.attname ORDER BY u.ordinality)
     FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ordinality)
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
    ) AS columns,
    (SELECT ARRAY_AGG(att.attname ORDER BY u.ordinality)
     FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ordinality)
     JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum
    ) AS ref_columns,
    con.confupdtype::text AS on_update,
    con.confdeltype::text AS on_delete,
    con.condeferrable AS deferrable,
    con.condeferred AS deferred,
    con.convalidated AS validated
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE con.conrelid IN (SELECT table_oid FROM tables)
),
indexes AS (
  SELECT
    i.indrelid AS table_oid,
    ic.relname AS index_name,
    i.indisprimary AS is_primary,
    i.indisunique AS is_unique,
    i.indisvalid AS is_valid,
    i.indisready AS is_ready,
    pg_get_indexdef(i.indexrelid, 0, true) AS definition
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid IN (SELECT table_oid FROM tables)
),
triggers AS (
  SELECT
    t.tgrelid AS table_oid,
    t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid, true) AS definition,
    (NOT t.tgenabled = 'D') AS enabled
  FROM pg_trigger t
  WHERE t.tgrelid IN (SELECT table_oid FROM tables)
    AND NOT t.tgisinternal
),
rls AS (
  SELECT
    c.oid AS table_oid,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  WHERE c.oid IN (SELECT table_oid FROM tables)
),
policies AS (
  SELECT
    schemaname AS schema_name,
    tablename AS table_name,
    policyname AS policy_name,
    permissive,
    roles,
    cmd,
    qual,
    with_check
  FROM pg_policies
  WHERE (schemaname || '.' || tablename) IN (
    SELECT schema_name || '.' || table_name FROM tables WHERE relkind IN ('r','p','f')
  )
),
enums AS (
  SELECT
    n.nspname AS schema_name,
    t.typname AS enum_name,
    ARRAY_AGG(e.enumlabel ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.oid IN (SELECT schema_oid FROM schemas)
  GROUP BY 1,2
),
functions AS (
  SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS identity_args,
    pg_get_function_result(p.oid) AS returns,
    l.lanname AS language,
    p.provolatile::text AS volatility,
    p.prosecdef AS security_definer,
    pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.oid IN (SELECT schema_oid FROM schemas)
),
extensions AS (
  SELECT
    extname,
    extversion,
    extnamespace::regnamespace::text AS schema_name
  FROM pg_extension
  ORDER BY extname
)
SELECT jsonb_build_object(
  'db', (SELECT db FROM params),
  'capturedAt', (SELECT captured_at FROM params),
  'schemas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', schema_name) ORDER BY schema_name), '[]'::jsonb) FROM schemas),
  'tables', (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'schema', t.schema_name,
        'name', t.table_name,
        'relkind', t.relkind,
        'qname', (t.schema_name || '.' || t.table_name),
        'stats', jsonb_build_object(
          'totalBytes', t.total_bytes,
          'heapBytes', t.heap_bytes,
          'estRows', t.est_rows,
          'seqScan', t.seq_scan,
          'idxScan', t.idx_scan
        ),
        'columns', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', c.column_name,
            'type', c.data_type,
            'notNull', c.not_null,
            'default', c.default_expr,
            'identity', NULLIF(c.identity, ''),
            'generated', NULLIF(c.generated, ''),
            'attnum', c.attnum
          ) ORDER BY c.attnum) FILTER (WHERE NOT c.dropped), '[]'::jsonb)
          FROM columns c
          WHERE c.table_oid = t.table_oid
        ),
        'constraints', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', con.name,
            'type', con.type,
            'definition', con.definition,
            'columns', con.columns,
            'refTableOid', con.ref_table_oid,
            'refColumns', con.ref_columns,
            'onUpdate', con.on_update,
            'onDelete', con.on_delete,
            'deferrable', con.deferrable,
            'deferred', con.deferred,
            'validated', con.validated
          ) ORDER BY con.name), '[]'::jsonb)
          FROM constraints con
          WHERE con.table_oid = t.table_oid
        ),
        'indexes', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', idx.index_name,
            'isPrimary', idx.is_primary,
            'isUnique', idx.is_unique,
            'isValid', idx.is_valid,
            'isReady', idx.is_ready,
            'definition', idx.definition
          ) ORDER BY idx.index_name), '[]'::jsonb)
          FROM indexes idx
          WHERE idx.table_oid = t.table_oid
        ),
        'triggers', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', tr.trigger_name,
            'enabled', tr.enabled,
            'definition', tr.definition
          ) ORDER BY tr.trigger_name), '[]'::jsonb)
          FROM triggers tr
          WHERE tr.table_oid = t.table_oid
        ),
        'rls', (
          SELECT jsonb_build_object(
            'enabled', r.rls_enabled,
            'forced', r.rls_forced,
            'policies', (
              SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'name', p.policy_name,
                'permissive', p.permissive,
                'roles', p.roles,
                'cmd', p.cmd,
                'qual', p.qual,
                'withCheck', p.with_check
              ) ORDER BY p.policy_name), '[]'::jsonb)
              FROM policies p
              WHERE p.schema_name = t.schema_name AND p.table_name = t.table_name
            )
          )
          FROM rls r
          WHERE r.table_oid = t.table_oid
        )
      )
      ORDER BY t.schema_name, t.table_name
    ), '[]'::jsonb)
    FROM tables t
  ),
  'enums', (SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', schema_name, 'name', enum_name, 'labels', labels) ORDER BY schema_name, enum_name), '[]'::jsonb) FROM enums),
  'functions', (SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', schema_name, 'name', function_name, 'identityArgs', identity_args, 'returns', returns, 'language', language, 'volatility', volatility, 'securityDefiner', security_definer, 'definition', definition) ORDER BY schema_name, function_name), '[]'::jsonb) FROM functions),
  'extensions', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', extname, 'version', extversion, 'schema', schema_name) ORDER BY extname), '[]'::jsonb) FROM extensions)
) AS snapshot;
  `;
}

async function runPsqlJson({ connectionString, sql, timeoutMs = 60_000 }) {
  const psql = process.env.PSQL_PATH || 'psql';
  const ok = await commandExists(psql);
  if (!ok) {
    const e = new Error('psql is required for schema introspection. Install PostgreSQL client tools or set PSQL_PATH.');
    e.code = 'MISSING_PSQL';
    throw e;
  }

  const args = [
    connectionString,
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-t',
    '-A',
    '-P',
    'pager=off',
    '-c',
    sql,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(psql, args, {
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error(`psql timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err || `psql exited with code ${code}`));
      const trimmed = out.trim();
      const json = safeJsonParse(trimmed);
      if (!json) {
        return reject(new Error('Failed to parse introspection JSON from psql output'));
      }
      resolve(json);
    });
  });
}

async function getSchemaSnapshot({ connectionString, filters } = {}) {
  const sql = buildSnapshotSql(filters);
  const snapshot = await runPsqlJson({ connectionString, sql });
  return snapshot;
}

function normalizeSnapshot(snapshot) {
  const tables = Array.isArray(snapshot?.tables) ? snapshot.tables : [];

  const out = {
    db: snapshot?.db || null,
    capturedAt: snapshot?.capturedAt || null,
    tables: [],
    columns: [],
    foreignKeys: [],
    indexes: [],
    // advanced
    enums: snapshot?.enums || [],
    functions: snapshot?.functions || [],
    extensions: snapshot?.extensions || [],
  };

  // Precompute indexed columns per table from index definitions so the UI can show accurate IDX badges.
  // This is still sourced from system catalogs; we're just parsing the already-returned indexdef text.
  const indexedColumnsByTableId = new Map();
  for (const t of tables) {
    const tableId = t.qname;
    const idxs = Array.isArray(t.indexes) ? t.indexes : [];
    const set = new Set();
    for (const idx of idxs) {
      const def = String(idx.definition || '');
      // Example: CREATE UNIQUE INDEX name ON schema.table USING btree (col1, col2)
      const m = def.match(/\(([^)]+)\)/);
      if (!m) continue;
      const inside = m[1];
      // split by comma, keep simple identifiers, strip quotes and sort modifiers.
      for (const raw of inside.split(',')) {
        const token = raw.trim();
        if (!token) continue;
        // Take first identifier in expression.
        const ident = token
          .replaceAll('"', '')
          .replace(/\s+(ASC|DESC)\b/i, '')
          .replace(/\s+NULLS\s+(FIRST|LAST)\b/i, '')
          .trim();
        // Ignore expression indexes for now (contains '(' or spaces).
        if (!ident || ident.includes('(') || ident.includes(' ')) continue;
        set.add(ident);
      }
    }
    indexedColumnsByTableId.set(tableId, set);
  }

  for (const t of tables) {
    const tableId = t.qname;

    // Primary key columns: derive from constraint metadata (authoritative).
    // In the introspection SQL, constraints includes `columns` for each constraint.
    const constraints = Array.isArray(t.constraints) ? t.constraints : [];
    const pk = constraints.find((c) => c.type === 'p');
    const primaryKeyColumns = pk && Array.isArray(pk.columns) ? pk.columns : [];

    out.tables.push({
      id: tableId,
      schema: t.schema,
      name: t.name,
      relkind: t.relkind,
      primaryKeyColumns,
      indexedColumns: Array.from(indexedColumnsByTableId.get(tableId) || []),
      stats: t.stats || null,
      rls: t.rls || null,
    });

    const cols = Array.isArray(t.columns) ? t.columns : [];
    for (const c of cols) {
      out.columns.push({
        tableId,
        name: c.name,
        type: c.type,
        notNull: Boolean(c.notNull),
        default: c.default ?? null,
        identity: c.identity ?? null,
        generated: c.generated ?? null,
        attnum: c.attnum ?? null,
      });
    }

    const idxs = Array.isArray(t.indexes) ? t.indexes : [];
    for (const idx of idxs) {
      out.indexes.push({
        tableId,
        name: idx.name,
        isPrimary: Boolean(idx.isPrimary),
        isUnique: Boolean(idx.isUnique),
        isValid: Boolean(idx.isValid),
        isReady: Boolean(idx.isReady),
        definition: idx.definition || null,
      });
    }

    const cons = Array.isArray(t.constraints) ? t.constraints : [];
    for (const con of cons) {
      if (con.type !== 'f') continue;
      const def = String(con.definition || '');
      const m = def.match(/REFERENCES\s+([^\s(]+)\s*\(/i);
      const refRaw = m ? m[1].replaceAll('"', '') : null;
      const toTableId = refRaw ? (refRaw.includes('.') ? refRaw : `${t.schema}.${refRaw}`) : null;
      out.foreignKeys.push({
        id: `${tableId}::${con.name}`,
        name: con.name,
        fromTableId: tableId,
        fromColumns: Array.isArray(con.columns) ? con.columns : [],
        toTableId,
        toColumns: Array.isArray(con.refColumns) ? con.refColumns : [],
        onUpdate: con.onUpdate || null,
        onDelete: con.onDelete || null,
        deferrable: Boolean(con.deferrable),
        deferred: Boolean(con.deferred),
        validated: Boolean(con.validated),
      });
    }
  }

  return out;
}

module.exports = { getSchemaSnapshot, normalizeSnapshot };
