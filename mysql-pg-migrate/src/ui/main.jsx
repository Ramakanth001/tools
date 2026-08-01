import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../pg-backup/src/ui/styles/global.css';

const DEFAULT_RUNTIME = {
  toolId: 'mysql-pg-migrate',
  apiBasePath: '/api',
  homePath: '/',
  storagePrefix: 'mysql-pg-migrate',
};

const STANDALONE_RUNTIME = {
  toolId: 'mysql-pg-migrate',
  apiBasePath: '/api',
  homePath: '/',
  storagePrefix: 'mysql-pg-migrate.standalone',
};

const MASKED_CONNECTION_STRING = '[provided]';

let runtime = { ...DEFAULT_RUNTIME };

function setRuntime(next = {}) {
  runtime = { ...DEFAULT_RUNTIME, ...next };
  return runtime;
}

function trimTrailingSlash(s) {
  const v = String(s || '');
  if (!v || v === '/') return v || '/';
  return v.replace(/\/+$/, '');
}

function ensureLeadingSlash(s) {
  const v = String(s || '');
  if (!v) return '/';
  return v.startsWith('/') ? v : `/${v}`;
}

function joinPaths(base, next) {
  const a = trimTrailingSlash(ensureLeadingSlash(base || '/'));
  const b = String(next || '');
  if (!b || b === '/') return a || '/';
  const tail = b.startsWith('/') ? b : `/${b}`;
  return `${a}${tail}`.replace(/\/+/g, '/');
}

function resolveApiUrl(path = '') {
  const input = String(path || '');
  if (!input) return runtime.apiBasePath;
  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('/api/')) return input;
  return joinPaths(runtime.apiBasePath, input);
}

function getStorageKey(name) {
  return `${runtime.storagePrefix}.${String(name || '').replace(/^\.+/, '')}`;
}

function getAuthToken() {
  const tokenFromUrl = new URLSearchParams(window.location.search).get('token') || '';
  if (tokenFromUrl) localStorage.setItem('tools.authToken', tokenFromUrl);
  return tokenFromUrl || localStorage.getItem('tools.authToken') || '';
}

function getAuthHeaders() {
  const token = getAuthToken();
  return token ? { 'x-tools-auth': token } : {};
}

function withAuthQuery(url) {
  const token = getAuthToken();
  if (!token) return url;
  const next = new URL(url, window.location.origin);
  next.searchParams.set('token', token);
  return next.toString();
}

async function api(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('Request timeout')), timeoutMs);
  try {
    const resp = await fetch(resolveApiUrl(path), {
      method,
      headers: { ...getAuthHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      const msg = json.error ? (typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) : resp.statusText;
      const e = new Error(msg || 'Request failed');
      e.status = resp.status;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function openRunEventSource(runId, { onLog, onProgress, onStatus } = {}) {
  const ev = new EventSource(withAuthQuery(resolveApiUrl(`/runs/${encodeURIComponent(runId)}/events`)));
  ev.addEventListener('log', (e) => {
    try {
      onLog?.(JSON.parse(e.data));
    } catch {
      onLog?.({ level: 'info', message: String(e.data) });
    }
  });
  ev.addEventListener('progress', (e) => {
    try {
      onProgress?.(JSON.parse(e.data));
    } catch {
      // ignore
    }
  });
  ev.addEventListener('status', (e) => {
    try {
      onStatus?.(JSON.parse(e.data));
    } catch {
      // ignore
    }
  });
  ev.addEventListener('error', () => {
    try {
      ev.close();
    } catch {
      // ignore
    }
  });
  return ev;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(getStorageKey(key));
    const parsed = raw ? safeJsonParse(raw) : null;
    const value = parsed ?? fallback;
    return key === 'workspace' ? stripWorkspaceSecrets(value) : value;
  } catch {
    return fallback;
  }
}

function stripWorkspaceSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    sourceConnection: {
      ...(value.sourceConnection || {}),
      password: '',
      sslKey: '',
      connectionString: '',
    },
    targetConnection: {
      ...(value.targetConnection || {}),
      connectionString: '',
      pooler: value.targetConnection?.pooler
        ? { ...value.targetConnection.pooler, password: '' }
        : value.targetConnection?.pooler,
    },
  };
}

function saveLocal(key, value) {
  try {
    const safeValue = key === 'workspace' ? stripWorkspaceSecrets(value) : value;
    localStorage.setItem(getStorageKey(key), JSON.stringify(safeValue));
  } catch {
    // ignore
  }
}

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultSourceConnection() {
  return { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', sslMode: 'DISABLED', sslCa: '', sslCert: '', sslKey: '', connectionString: '', ref: '', consistentRead: { enabled: false, isolation: 'REPEATABLE READ' } };
}

function defaultTargetConnection() {
  return {
    ref: '',
    connectionString: '',
    pooler: { host: '127.0.0.1', port: 5432, user: 'postgres', database: '', password: '', sslmode: 'prefer' },
  };
}

function defaultContextState() {
  return {
    name: `migration-${new Date().toISOString().slice(0, 10)}`,
    sourceConnection: defaultSourceConnection(),
    targetConnection: defaultTargetConnection(),
    sourceSchema: '',
    targetSchema: 'public',
    includeViews: false,
  };
}

function normalizeSchemaValue(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim() || fallback;
}

function mysqlSchemaFallback(connection = {}) {
  return normalizeSchemaValue(connection.database, '');
}

function isUsableConnectionString(value) {
  const input = String(value || '').trim();
  return Boolean(input) && input !== MASKED_CONNECTION_STRING;
}

function mergeSourceConnection(saved = {}, current = {}) {
  const merged = {
    ...defaultSourceConnection(),
    ...current,
    ...saved,
  };
  merged.password = String(current.password || '');
  merged.connectionString = isUsableConnectionString(current.connectionString) ? String(current.connectionString) : '';
  merged.consistentRead = {
    ...defaultSourceConnection().consistentRead,
    ...(current.consistentRead || {}),
    ...(saved.consistentRead || {}),
  };
  return merged;
}

function mergeTargetConnection(saved = {}, current = {}) {
  const merged = {
    ...defaultTargetConnection(),
    ...current,
    ...saved,
    pooler: {
      ...defaultTargetConnection().pooler,
      ...(current.pooler || {}),
      ...(saved.pooler || {}),
    },
  };
  merged.connectionString = isUsableConnectionString(current.connectionString) ? String(current.connectionString) : '';
  merged.pooler.password = String(current.pooler?.password || '');
  return merged;
}

function mergeWorkspaceWithProject(project, currentWorkspace) {
  if (!project) return currentWorkspace;
  const sourceConnection = mergeSourceConnection(project.sourceConnection || {}, currentWorkspace.sourceConnection || {});
  const targetConnection = mergeTargetConnection(project.targetConnection || {}, currentWorkspace.targetConnection || {});
  return {
    ...currentWorkspace,
    name: project.name || currentWorkspace.name,
    sourceConnection,
    targetConnection,
    sourceSchema: normalizeSchemaValue(project.sourceSchema, normalizeSchemaValue(currentWorkspace.sourceSchema, mysqlSchemaFallback(sourceConnection))),
    targetSchema: normalizeSchemaValue(project.targetSchema, normalizeSchemaValue(currentWorkspace.targetSchema, 'public')),
    includeViews: project.includeViews ?? currentWorkspace.includeViews ?? false,
  };
}

function workspaceMatchesProject(workspace, project) {
  if (!workspace || !project?.id) return false;
  const payload = workspaceForCatalogRequest(workspace);
  const source = payload.sourceConnection || {};
  const savedSource = project.sourceConnection || {};
  const target = payload.targetConnection || {};
  const targetPooler = target.pooler || {};
  const savedTarget = project.targetConnection || {};
  const savedPooler = savedTarget.pooler || {};
  const sourceFields = ['host', 'port', 'user', 'database', 'ref', 'sslMode', 'sslCa', 'sslCert'];
  const targetFields = ['host', 'port', 'user', 'database', 'sslmode'];
  return cleanName(payload.name) === cleanName(project.name)
    && cleanName(payload.sourceSchema) === cleanName(project.sourceSchema)
    && cleanName(payload.targetSchema) === cleanName(project.targetSchema)
    && Boolean(payload.includeViews) === Boolean(project.includeViews)
    && sourceFields.every((key) => String(source[key] ?? '') === String(savedSource[key] ?? ''))
    && String(target.ref ?? '') === String(savedTarget.ref ?? '')
    && targetFields.every((key) => String(targetPooler[key] ?? '') === String(savedPooler[key] ?? ''));
}

function normalizeWorkspaceState(input = {}) {
  const sourceConnection = mergeSourceConnection(input.sourceConnection || {}, input.sourceConnection || {});
  const targetConnection = mergeTargetConnection(input.targetConnection || {}, input.targetConnection || {});
  return {
    ...defaultContextState(),
    ...input,
    sourceConnection,
    targetConnection,
    sourceSchema: normalizeSchemaValue(input.sourceSchema, mysqlSchemaFallback(sourceConnection)),
    targetSchema: normalizeSchemaValue(input.targetSchema, 'public'),
    includeViews: Boolean(input.includeViews),
  };
}

function workspaceForCatalogRequest(workspace) {
  const normalized = normalizeWorkspaceState(workspace || {});
  return {
    ...normalized,
    sourceSchema: normalizeSchemaValue(normalized.sourceSchema, mysqlSchemaFallback(normalized.sourceConnection)),
    targetSchema: normalizeSchemaValue(normalized.targetSchema, 'public'),
  };
}

function redactSourceConnectionForProject(connection = {}) {
  return {
    ...connection,
    password: undefined,
    sslKey: undefined,
    connectionString: '',
    ref: connection.ref || connection.database || 'source',
  };
}

function redactTargetConnectionForProject(connection = {}) {
  return {
    ...connection,
    connectionString: '',
    ref: connection.ref || connection.pooler?.database || 'target',
    pooler: connection.pooler ? { ...connection.pooler, password: undefined } : undefined,
  };
}

function tableByName(catalog, tableName) {
  const wanted = cleanName(tableName);
  return catalogTables(catalog).find((table) => cleanName(table.name) === wanted) || null;
}

function columnByName(table, columnName) {
  const wanted = cleanName(columnName);
  return tableColumns(table).find((column) => cleanName(column.name) === wanted) || null;
}

function cleanName(value) {
  return String(value || '').trim();
}

function pickAny(object, keys = [], fallback = undefined) {
  if (!object || typeof object !== 'object') return fallback;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  const lowerLookup = new Map(Object.keys(object).map((key) => [String(key).toLowerCase(), key]));
  for (const key of keys) {
    const actual = lowerLookup.get(String(key).toLowerCase());
    if (actual && Object.prototype.hasOwnProperty.call(object, actual)) return object[actual];
  }
  return fallback;
}

function uniqueCleanNames(items = []) {
  return Array.from(new Set((items || []).map(cleanName).filter(Boolean)));
}

function normalizeCatalogColumn(column = {}) {
  const name = cleanName(pickAny(column, ['name', 'columnName', 'column_name', 'COLUMN_NAME']));
  if (!name) return null;
  return {
    ...column,
    name,
    table: cleanName(pickAny(column, ['table', 'tableName', 'table_name', 'TABLE_NAME'], column.table || '')),
    fullType: pickAny(column, ['fullType', 'columnType', 'column_type', 'COLUMN_TYPE'], column.fullType || column.dataType || ''),
    dataType: pickAny(column, ['dataType', 'data_type', 'DATA_TYPE'], column.dataType || ''),
    key: pickAny(column, ['key', 'columnKey', 'column_key', 'COLUMN_KEY'], column.key || ''),
  };
}

function normalizeCatalogTable(table = {}) {
  const name = cleanName(pickAny(table, ['name', 'tableName', 'table_name', 'TABLE_NAME']));
  if (!name) return null;
  return {
    ...table,
    name,
    kind: cleanName(pickAny(table, ['kind', 'type', 'tableType', 'table_type', 'TABLE_TYPE'], table.kind || 'table')).toLowerCase() === 'view' ? 'view' : (table.kind || 'table'),
    columns: (table.columns || table.Columns || [])
      .map(normalizeCatalogColumn)
      .filter(Boolean),
  };
}

function normalizeCatalog(catalog = {}) {
  const tables = (catalog?.tables || catalog?.Tables || [])
    .map(normalizeCatalogTable)
    .filter(Boolean);
  return {
    ...(catalog || {}),
    schema: cleanName(pickAny(catalog, ['schema', 'schemaName', 'schema_name', 'database'], catalog?.schema || '')),
    tables,
  };
}

function resolveCatalog(primary, fallback) {
  const normalizedPrimary = normalizeCatalog(primary || {});
  if (normalizedPrimary.tables.length) return normalizedPrimary;
  return normalizeCatalog(fallback || {});
}

function catalogTables(catalog) {
  return normalizeCatalog(catalog || {}).tables;
}

function tableColumns(table) {
  return (table?.columns || table?.Columns || []).map(normalizeCatalogColumn).filter(Boolean);
}

function normalizeProjectForUi(project) {
  if (!project) return null;
  const dedupeKeyCounts = new Map();
  const normalizedTableMappings = [];
  for (const mapping of (project.tableMappings || [])) {
    const normalizedMapping = {
      ...mapping,
      sourceTable: cleanName(pickAny(mapping, ['sourceTable', 'source_table', 'source'], mapping.sourceTable || '')),
      targetTable: cleanName(pickAny(mapping, ['targetTable', 'target_table', 'target'], mapping.targetTable || '')) || null,
      columnMappings: (mapping.columnMappings || []).map((column) => ({
        ...column,
        sourceColumn: cleanName(pickAny(column, ['sourceColumn', 'source_column', 'source'], column.sourceColumn || '')),
        targetColumn: cleanName(pickAny(column, ['targetColumn', 'target_column', 'target'], column.targetColumn || '')) || null,
      })),
    };
    const dedupeKey = `${normalizedMapping.sourceTable}=>${normalizedMapping.targetTable || ''}`;
    const seen = dedupeKeyCounts.get(dedupeKey) || 0;
    dedupeKeyCounts.set(dedupeKey, seen + 1);
    if (seen === 0) normalizedTableMappings.push(normalizedMapping);
  }
  return {
    ...project,
    sourceCatalog: normalizeCatalog(project.sourceCatalog || {}),
    targetCatalog: normalizeCatalog(project.targetCatalog || {}),
    tableMappings: normalizedTableMappings,
  };
}

function schemaNamesFromLoadedProject(project) {
  if (!project) return { sourceSchemas: [], targetSchemas: [] };
  return {
    sourceSchemas: uniqueCleanNames([
      project.sourceConnection?.database,
      project.sourceSchema,
      project.sourceCatalog?.schema,
    ]),
    targetSchemas: uniqueCleanNames([
      project.targetSchema,
      project.targetCatalog?.schema,
    ]),
  };
}

function dedupeTableMappings(tableMappings = []) {
  const seen = new Set();
  const next = [];
  for (const mapping of tableMappings || []) {
    const source = cleanName(mapping?.sourceTable);
    const target = cleanName(mapping?.targetTable);
    const key = `${source}=>${target}`;
    if (!source) {
      next.push(mapping);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(mapping);
  }
  return next.map((item, order) => ({ ...item, order }));
}

function describeColumn(column) {
  if (!column) return '';
  const parts = [column.fullType || column.dataType].filter(Boolean);
  if (Array.isArray(column.primaryKey) && column.primaryKey.length) parts.push('PK');
  if (column.nullable === false) parts.push('not null');
  if (column.defaultValue) parts.push('default');
  return parts.join(' • ');
}

function describeCompactColumn(column) {
  if (!column) return 'unknown';
  const parts = [column.fullType || column.dataType || 'unknown'];
  const flags = [];
  if (column.nullable === false) flags.push('not null');
  if (column.key) flags.push(column.key);
  if (column.identity) flags.push('identity');
  if (column.generated) flags.push('generated');
  if (flags.length) parts.push(`(${flags.join(', ')})`);
  return parts.join(' ');
}

function normalizeExactRowCount(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return text;
}

function normalizeRowCountForDisplay(table = {}) {
  const exact = normalizeExactRowCount(table.rowCountExact ?? table.rows ?? table.tableRows);
  if (exact != null) return exact;
  const estimate = Number(table.rowEstimate);
  if (Number.isFinite(estimate) && estimate >= 0) return String(Math.trunc(estimate));
  return '0';
}

function compareNumericStrings(a, b) {
  const left = normalizeExactRowCount(a);
  const right = normalizeExactRowCount(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const leftBig = BigInt(left);
  const rightBig = BigInt(right);
  if (leftBig < rightBig) return -1;
  if (leftBig > rightBig) return 1;
  return 0;
}

function buildCatalogSummary(catalog = {}) {
  const normalized = normalizeCatalog(catalog || {});
  const tables = [];
  for (const table of catalogTables(normalized)) {
    const columns = tableColumns(table);
    const primaryKeys = columns
      .filter((column) => String(column.key || '').toUpperCase() === 'PRI' || column.primaryKey === true || column.isPrimaryKey === true)
      .map((column) => column.name);
    tables.push({
      name: table.name,
      kind: table.kind || 'table',
      rows: normalizeRowCountForDisplay(table),
      columnCount: columns.length,
      primaryKeys,
      foreignKeyCount: (table.foreignKeys || table.foreign_keys || []).length,
    });
  }
  return {
    engine: normalized.engine || catalog.engine || 'unknown',
    schema: normalized.schema || catalog.schema || '',
    tableCount: tables.length,
    tables,
  };
}

function CatalogPreview({ title, catalog }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'name', direction: 'asc' });
  const summary = buildCatalogSummary(catalog || {});
  const visibleTables = useMemo(() => {
    const q = cleanName(search).toLowerCase();
    const filtered = q
      ? summary.tables.filter((table) => [
        table.name,
        table.kind,
        table.rows,
        table.columnCount,
        table.primaryKeys.join(', '),
        table.foreignKeyCount,
      ].some((value) => String(value ?? '').toLowerCase().includes(q)))
      : summary.tables;
    const direction = sort.direction === 'desc' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      let result = 0;
      if (sort.key === 'rows') result = compareNumericStrings(a.rows, b.rows);
      else if (sort.key === 'columnCount' || sort.key === 'foreignKeyCount') result = Number(a[sort.key] || 0) - Number(b[sort.key] || 0);
      else if (sort.key === 'primaryKeys') result = a.primaryKeys.join(', ').localeCompare(b.primaryKeys.join(', '));
      else result = String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? ''));
      return result * direction;
    });
  }, [search, sort.direction, sort.key, summary.tables]);
  function toggleSort(key) {
    setSort((curr) => ({ key, direction: curr.key === key && curr.direction === 'asc' ? 'desc' : 'asc' }));
  }
  function SortHeader({ columnKey, align = 'left', children }) {
    const active = sort.key === columnKey;
    return (
      <th
        onClick={() => toggleSort(columnKey)}
        title="Click to sort"
        style={{ textAlign: align, padding: 8, cursor: 'pointer', position: 'sticky', top: 0, background: '#101820', zIndex: 1 }}
      >
        {children}{active ? ` ${sort.direction === 'asc' ? '↑' : '↓'}` : ''}
      </th>
    );
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="toolbar" style={{ marginTop: 8, marginBottom: 12 }}>
        <span className="badge">Engine: {summary.engine}</span>
        <span className="badge">Schema: {summary.schema || '—'}</span>
        <span className="badge">Tables: {summary.tableCount}</span>
        <span className="badge">Exact row counts</span>
      </div>
      <div className="field full" style={{ marginBottom: 12 }}>
        <div className="field-label">Search catalog</div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by table, kind, rows, primary key, or FK count" />
      </div>
      <div className="schema-table-scroll" style={{ maxHeight: 560, overflow: 'auto' }}>
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <SortHeader columnKey="name">Table</SortHeader>
              <SortHeader columnKey="kind">Kind</SortHeader>
              <SortHeader columnKey="rows" align="right">Rows</SortHeader>
              <SortHeader columnKey="columnCount" align="right">Columns</SortHeader>
              <SortHeader columnKey="primaryKeys">Primary key</SortHeader>
              <SortHeader columnKey="foreignKeyCount" align="right">FKs</SortHeader>
            </tr>
          </thead>
          <tbody>
            {visibleTables.map((table) => (
              <tr key={table.name}>
                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.name}</td>
                <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.kind}</td>
                <td style={{ padding: 8, textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.rows ?? '—'}</td>
                <td style={{ padding: 8, textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.columnCount}</td>
                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.primaryKeys.length ? table.primaryKeys.join(', ') : '—'}</td>
                <td style={{ padding: 8, textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.08)' }}>{table.foreignKeyCount}</td>
              </tr>
            ))}
            {!visibleTables.length ? (
              <tr>
                <td colSpan={6} className="hint" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{summary.tables.length ? 'No tables match this search.' : 'No tables found in this introspection result.'}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary className="btn" style={{ display: 'inline-flex' }}>Full schema introspection</summary>
        <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', marginTop: 12 }}>{formatJson(catalog || {})}</div>
      </details>
    </div>
  );
}

function createBlankColumnMapping(sourceTable, sourceColumn, index = 0) {
  return {
    id: `${sourceTable || 'table'}:${sourceColumn || 'column'}:${Date.now()}:${index}`,
    sourceColumn: sourceColumn || '',
    targetColumn: null,
    targetColumnMode: 'existing',
    transform: { type: 'direct', config: {} },
    enabled: true,
  };
}

function summarizeColumnMapping(tableMapping, columnMapping, sourceCatalog, targetCatalog) {
  const sourceTable = tableByName(sourceCatalog, tableMapping?.sourceTable);
  const targetTable = tableByName(targetCatalog, tableMapping?.targetTable);
  const sourceColumn = columnByName(sourceTable, columnMapping?.sourceColumn);
  const targetColumn = columnByName(targetTable, columnMapping?.targetColumn);
  const targetMode = columnMapping?.targetColumnMode || (columnMapping?.targetColumn ? (targetColumn ? 'existing' : 'create_new') : 'ignore');
  return {
    sourceColumn: columnMapping?.sourceColumn || '—',
    sourceType: describeColumn(sourceColumn) || '—',
    targetColumn: targetMode === 'ignore' ? 'ignored' : (columnMapping?.targetColumn || '—'),
    targetType: targetMode === 'ignore' ? '—' : (targetMode === 'create_new' ? 'new column' : (describeColumn(targetColumn) || '—')),
    transform: columnMapping?.transform?.preset || columnMapping?.transform?.type || 'direct',
    state: columnMapping?.columnState || columnMapping?.state || '—',
  };
}

function summarizeTableMapping(tableMapping, sourceCatalog, targetCatalog) {
  return {
    sourceTable: tableMapping?.sourceTable || '—',
    targetTable: tableMapping?.targetTable || (tableMapping?.targetTableMode === 'create_new' ? 'new table' : '—'),
    enabled: tableMapping?.enabled !== false,
    writeMode: tableMapping?.writeMode || 'append',
    loadStrategy: tableMapping?.loadStrategy?.mode || 'historical_full',
    columnCount: (tableMapping?.columnMappings || []).length,
    columns: (tableMapping?.columnMappings || []).map((column) => summarizeColumnMapping(tableMapping, column, sourceCatalog, targetCatalog)),
  };
}

function MappingSummaryCard({ project, sourceCatalog, targetCatalog, title = 'Saved mapping summary', hint = 'Brief summary of the currently saved table and column mappings.' }) {
  const summaries = (project?.tableMappings || []).map((mapping) => summarizeTableMapping(mapping, sourceCatalog, targetCatalog));
  if (!summaries.length) return null;
  return (
    <div className="card" style={{ background: 'rgba(16,185,129,0.06)' }}>
      <SectionTitle title={title} hint={hint} action={<span className="badge">Tables: {summaries.length}</span>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {summaries.map((item, index) => (
          <div key={`${item.sourceTable}:${item.targetTable}:${index}`} className="card" style={{ background: 'rgba(255,255,255,0.02)', padding: 14 }}>
            <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 800 }}>{item.sourceTable} → {item.targetTable}</div>
                <div className="hint">{item.enabled ? 'enabled' : 'disabled'} • write mode: {item.writeMode} • load strategy: {item.loadStrategy} • columns: {item.columnCount}</div>
              </div>
            </div>
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Source column</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Source type</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Target column</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Target type</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Transform</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {item.columns.map((column, colIndex) => (
                    <tr key={`${item.sourceTable}:${column.sourceColumn}:${colIndex}`}>
                      <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.sourceColumn}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.sourceType}</td>
                      <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.targetColumn}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.targetType}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.transform}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildManualProjectPayload({ workspace, introspection, tableMappings = [] }) {
  const payload = workspaceForCatalogRequest(workspace);
  const sourceCatalog = normalizeCatalog(introspection?.source || { tables: [] });
  const targetCatalog = normalizeCatalog(introspection?.target || { tables: [] });
  return {
    name: payload.name || `migration-${Date.now()}`,
    notes: 'Manual mapping project. Define table and column intent explicitly in the Mapping tab.',
    sourceConnection: redactSourceConnectionForProject(payload.sourceConnection),
    targetConnection: redactTargetConnectionForProject(payload.targetConnection),
    sourceSchema: payload.sourceSchema,
    targetSchema: payload.targetSchema,
    includeViews: payload.includeViews,
    sourceCatalog,
    targetCatalog,
    tableMappings,
    allowedVerificationIssues: [],
    mappingSummary: {
      mode: 'manual',
      sourceTables: sourceCatalog.tables?.length || 0,
      targetTables: targetCatalog.tables?.length || 0,
      mappedTables: tableMappings.filter((mapping) => mapping.targetTable).length,
    },
    versions: [{ createdAt: nowIso(), tableMappings }],
    schemaVersion: 2,
  };
}

function isProjectNameChanged(newName, currentProject) {
  const next = cleanName(newName);
  const current = cleanName(currentProject?.name);
  return Boolean(next) && Boolean(current) && next !== current;
}

function buildRuntimeOverrides(workspace, { includeSource = true, includeTarget = true } = {}) {
  const body = {};
  if (includeSource) body.sourceConnection = workspace?.sourceConnection || defaultSourceConnection();
  if (includeTarget) body.targetConnection = workspace?.targetConnection || defaultTargetConnection();
  return body;
}

function buildExecutionOptionsSignature(options = {}, selectedTables = []) {
  return JSON.stringify({
    mode: options.mode || 'all',
    selectedTables: Array.isArray(selectedTables) ? [...selectedTables].sort() : [],
    dryRun: Boolean(options.dryRun),
    errorPolicy: options.errorPolicy || 'fail-fast',
    concurrency: Number(options.concurrency || 1),
    batchSize: Number(options.batchSize || 1000),
    cdcMode: options.cdcMode || 'off',
    loadPhase: options.loadPhase || 'configured',
    cutoverMode: options.cutoverMode || 'manual',
    watermarkColumn: options.watermarkColumn || '',
  });
}

function normalizePreviewSelectedTables(selectedTables = []) {
  return Array.from(new Set((selectedTables || []).map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

function transformPreviewCoversRun(preview, options = {}, selectedTables = []) {
  if (!preview?.transformFingerprint || !preview.scope) return false;
  const runMode = options.mode === 'selected' ? 'selected' : 'all';
  const runSelected = runMode === 'selected' ? normalizePreviewSelectedTables(selectedTables) : [];
  const previewMode = preview.scope.mode === 'selected' ? 'selected' : 'all';
  const previewSelected = normalizePreviewSelectedTables(preview.scope.selectedTables || []);
  if ((preview.scope.loadPhase || 'configured') !== (options.loadPhase || 'configured')) return false;
  if (runMode === 'all') return previewMode === 'all';
  if (previewMode === 'all') return true;
  const previewSet = new Set(previewSelected);
  return runSelected.every((table) => previewSet.has(table));
}

function buildDryRunSqlText(preview = {}) {
  function sqlLiteral(value) {
    if (value == null) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
    if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  const lines = ['-- mysql-pg-migrate dry run SQL reference', `-- generatedAt: ${preview?.generatedAt || nowIso()}`, ''];
  for (const table of preview?.tables || []) {
    lines.push(`-- Source table: ${table.sourceTable || 'unknown'}`);
    lines.push(`-- Target table: ${table.targetTable || 'unknown'}`);
    lines.push(`-- Write mode: ${table.writeMode || 'append'}`);
    const columns = Array.from(new Set((table.columnMappings || []).filter((item) => item?.enabled !== false && item?.targetColumnMode !== 'ignore' && item?.targetColumn).map((item) => item.targetColumn)));
    const sampleRows = Array.isArray(table.transformedRows) ? table.transformedRows.filter(Boolean) : [];
    if (table.writeMode === 'truncate') {
      lines.push(`TRUNCATE TABLE ${table.targetTable};`);
    }
    if (columns.length) {
      if (sampleRows.length) {
        const tuples = sampleRows.map((row) => `  (${columns.map((column) => sqlLiteral(row?.[column])).join(', ')})`);
        lines.push(`INSERT INTO ${table.targetTable} (${columns.join(', ')}) VALUES`);
        lines.push(`${tuples.join(',\n')};`);
      } else {
        lines.push(`INSERT INTO ${table.targetTable} (${columns.join(', ')}) VALUES (...);`);
      }
      if (table.writeMode === 'upsert') {
        const conflictKeys = table.conflictKeys || [];
        lines.push(`-- upsert reference`);
        if (sampleRows.length) {
          const tuples = sampleRows.map((row) => `  (${columns.map((column) => sqlLiteral(row?.[column])).join(', ')})`);
          const updateColumns = columns.filter((column) => !conflictKeys.includes(column));
          lines.push(`INSERT INTO ${table.targetTable} (${columns.join(', ')}) VALUES`);
          lines.push(`${tuples.join(',\n')} ON CONFLICT (${conflictKeys.join(', ') || '...keys...'}) DO UPDATE SET ${updateColumns.length ? updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(', ') : '/* no-op */'};`);
        } else {
          lines.push(`INSERT INTO ${table.targetTable} (${columns.join(', ')}) VALUES (...) ON CONFLICT (${conflictKeys.join(', ') || '...keys...'}) DO UPDATE SET ...;`);
        }
      }
    } else {
      lines.push(`-- No active target columns mapped for ${table.targetTable || table.sourceTable || 'unknown'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const AppContext = createContext(null);

function AppProvider({ children }) {
  const [tab, setTab] = useState(() => localStorage.getItem(getStorageKey('tab')) || 'workspace');
  const [workspace, setWorkspace] = useState(() => normalizeWorkspaceState(loadLocal('workspace', defaultContextState())));
  const [projects, setProjects] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem(getStorageKey('selected_project_id')) || '');
  const [selectedRunId, setSelectedRunId] = useState(() => localStorage.getItem(getStorageKey('selected_run_id')) || '');
  const [currentProject, setCurrentProject] = useState(null);
  const [currentRun, setCurrentRun] = useState(null);
  const [preflightReport, setPreflightReport] = useState(null);
  const [transformPreview, setTransformPreview] = useState(null);
  const [dryRunPreview, setDryRunPreview] = useState(null);
  const [runReport, setRunReport] = useState(null);
  const [cutoverReport, setCutoverReport] = useState(null);
  const [introspection, setIntrospection] = useState(null);
  const [sourceSchemas, setSourceSchemas] = useState([]);
  const [targetSchemas, setTargetSchemas] = useState([]);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState([]);
  const [transformCatalog, setTransformCatalog] = useState([]);
  const eventSourceRef = useRef(null);
  const alertRef = useRef(null);

  function clearProjectDerivedState({ keepIntrospection = false, keepMessage = false } = {}) {
    setCurrentProject(null);
    setSelectedProjectId('');
    setCurrentRun(null);
    setSelectedRunId('');
    setPreflightReport(null);
    setTransformPreview(null);
    setDryRunPreview(null);
    setRunReport(null);
    setCutoverReport(null);
    if (!keepIntrospection) setIntrospection(null);
    setLogs([]);
    if (!keepMessage) setMessage('');
    setError('');
    setMappingDirty(false);
  }

  useEffect(() => saveLocal('workspace', workspace), [workspace]);
  useEffect(() => localStorage.setItem(getStorageKey('tab'), tab), [tab]);
  useEffect(() => localStorage.setItem(getStorageKey('selected_project_id'), selectedProjectId), [selectedProjectId]);
  useEffect(() => localStorage.setItem(getStorageKey('selected_run_id'), selectedRunId), [selectedRunId]);

  async function withBusy(key, fn) {
    setBusy((curr) => ({ ...curr, [key]: true }));
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e?.message || String(e));
      throw e;
    } finally {
      setBusy((curr) => ({ ...curr, [key]: false }));
    }
  }

  async function refreshProjects() {
    const resp = await api('/projects');
    setProjects(Array.isArray(resp.projects) ? resp.projects : []);
    return resp.projects || [];
  }

  async function refreshRuns() {
    const resp = await api('/runs');
    setRuns(Array.isArray(resp.runs) ? resp.runs : []);
    return resp.runs || [];
  }

  async function loadProject(projectId, { loadIntoWorkspace = false } = {}) {
    if (!projectId) {
      setCurrentProject(null);
      return null;
    }
    const resp = await api(`/projects/${encodeURIComponent(projectId)}`);
    const project = normalizeProjectForUi(resp.project || null);
    setCurrentProject(project || null);
    setMappingDirty(false);
    setSelectedProjectId(project?.id || '');
    setCurrentRun(null);
    setSelectedRunId('');
    setPreflightReport(null);
    setTransformPreview(null);
    setDryRunPreview(null);
    setRunReport(null);
    setCutoverReport(null);
    setLogs([]);
    if (loadIntoWorkspace) {
      const schemaNames = schemaNamesFromLoadedProject(project);
      setWorkspace((curr) => mergeWorkspaceWithProject(project || null, curr));
      setSourceSchemas(schemaNames.sourceSchemas);
      setTargetSchemas(schemaNames.targetSchemas);
      setIntrospection(project ? { source: project.sourceCatalog || {}, target: project.targetCatalog || {} } : null);
    }
    return project || null;
  }

  async function loadRun(runId) {
    if (!runId) {
      setCurrentRun(null);
      return null;
    }
    const resp = await api(`/runs/${encodeURIComponent(runId)}`);
    setCurrentRun(resp.run || null);
    setSelectedRunId(resp.run?.id || '');
    return resp.run || null;
  }

  async function loadRunReport(runId) {
    if (!runId) return null;
    const resp = await api(`/runs/${encodeURIComponent(runId)}/report`, {
      method: 'POST',
      body: buildRuntimeOverrides(workspace),
      timeoutMs: 120000,
    });
    setRunReport(resp.report || null);
    return resp.report || null;
  }

  function stopRunStream() {
    try {
      eventSourceRef.current?.close();
    } catch {
      // ignore
    }
    eventSourceRef.current = null;
  }

  function streamRun(runId) {
    stopRunStream();
    if (!runId) return;
    eventSourceRef.current = openRunEventSource(runId, {
      onLog: (entry) => setLogs((curr) => [...curr, { at: nowIso(), ...entry }].slice(-1000)),
      onProgress: async () => {
        await loadRun(runId).catch(() => null);
      },
      onStatus: async (status) => {
        setMessage(`Run ${runId} status: ${status?.status || 'updated'}`);
        const run = await loadRun(runId).catch(() => null);
        if (run?.status && ['done', 'error', 'previewed'].includes(run.status)) {
          await loadRunReport(runId).catch(() => null);
          await refreshRuns().catch(() => []);
          stopRunStream();
        }
      },
    });
  }

  useEffect(() => {
    void refreshProjects();
    void refreshRuns();
    void api('/transforms/catalog').then((resp) => setTransformCatalog(resp.transforms || [])).catch(() => []);
    return () => stopRunStream();
  }, []);

  useEffect(() => {
    if (selectedProjectId && !currentProject) void loadProject(selectedProjectId);
  }, [selectedProjectId, currentProject]);

  useEffect(() => {
    if (selectedRunId) {
      void loadRun(selectedRunId);
      void loadRunReport(selectedRunId).catch(() => null);
    }
  }, [selectedRunId]);

  useEffect(() => {
    if (!message && !error) return;
    try {
      alertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // ignore scroll failures
    }
  }, [message, error]);

  const value = useMemo(() => ({
    tab, setTab,
    workspace, setWorkspace,
    projects, runs,
    selectedProjectId, setSelectedProjectId,
    selectedRunId, setSelectedRunId,
    currentProject, setCurrentProject,
    currentRun, setCurrentRun,
    preflightReport, setPreflightReport,
    transformPreview, setTransformPreview,
    dryRunPreview, setDryRunPreview,
    runReport, setRunReport,
    cutoverReport, setCutoverReport,
    introspection, setIntrospection,
    sourceSchemas, setSourceSchemas,
    targetSchemas, setTargetSchemas,
    mappingDirty, setMappingDirty,
    busy, withBusy,
    message, setMessage,
    error, setError,
    alertRef,
    logs, setLogs,
    transformCatalog,
    clearProjectDerivedState,
    refreshProjects, refreshRuns, loadProject, loadRun, loadRunReport, streamRun,
  }), [tab, workspace, projects, runs, selectedProjectId, selectedRunId, currentProject, currentRun, preflightReport, transformPreview, dryRunPreview, runReport, cutoverReport, introspection, sourceSchemas, targetSchemas, mappingDirty, busy, message, error, logs, transformCatalog]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

function SectionTitle({ title, hint, action }) {
  return (
    <div className="panel-header" style={{ padding: 0, border: 0, marginBottom: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {hint ? <div className="hint" style={{ marginTop: 6 }}>{hint}</div> : null}
      </div>
      {action ? <div className="toolbar">{action}</div> : null}
    </div>
  );
}

function FirstRunChecklist() {
  const steps = [
    'Use staging or a disposable target first; do not start with production.',
    'In Workspace, enter a project name, load both schemas, and preview/introspect schemas.',
    'Continue to Mapping; all table and column mapping is manual.',
    'In Mapping, choose source and target tables from dropdowns; type only for new target tables.',
    'Map columns using dropdowns; mark unused source columns as ignore/unmapped.',
    'Choose write mode: truncate for full replacement, append for empty/append-only targets, upsert for retry-safe/incremental loads.',
    'For upsert or incremental loads, select real target conflict keys that match a primary key or unique key.',
    'Pick the load strategy per table: historical full, historical filtered, incremental watermark, or historical + then incremental.',
    'For incremental loads, configure watermark column, tie-breaker column, optional lookback, and delete-handling expectation.',
    'Continue to Transform; configure row filters, value maps, expressions, constants, templates, and lookup-table joins.',
    'Preview transforms, then continue to Validate & Run. Dry run refreshes Transform preview, runs Verify project and Preflight first, and only then prepares a load preview.',
  ];
  return (
    <div className="card" style={{ background: 'rgba(59,130,246,0.06)' }}>
      <SectionTitle title="First-run migration checklist" hint="Follow this path the first time you use the tool so you do not accidentally run an incomplete or unsafe migration." />
      <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step, index) => <li key={index} className="hint">{step}</li>)}
      </ol>
    </div>
  );
}

function toneForTrust(level) {
  if (level === 'verified') return '#16a34a';
  if (level === 'verified_with_warnings') return '#d97706';
  if (level === 'needs_manual_review') return '#dc2626';
  return 'rgba(255,255,255,0.7)';
}

function TrustBadge({ level, label }) {
  if (!level) return <span className="badge">{label || '—'}</span>;
  return <span className="badge" style={{ borderColor: toneForTrust(level), color: toneForTrust(level) }}>{label || level}</span>;
}

function renderWarningList(items = []) {
  if (!items.length) return '—';
  return items.map((item) => item.message || item.kind || String(item)).join(' • ');
}

function ConnectionFields() {
  const { workspace, setWorkspace, sourceSchemas, targetSchemas, setSourceSchemas, setTargetSchemas, withBusy, busy, setMessage } = useApp();
  const source = workspace.sourceConnection;
  const target = workspace.targetConnection;
  const effectiveSourceSchema = cleanName(workspace.sourceSchema) || cleanName(source.database);

  function patchSource(patch) {
    setWorkspace((curr) => {
      const previousDatabase = cleanName(curr.sourceConnection?.database);
      const nextSourceConnection = { ...curr.sourceConnection, ...patch };
      const next = { ...curr, sourceConnection: nextSourceConnection };
      if (Object.prototype.hasOwnProperty.call(patch, 'database')) {
        const nextDatabase = cleanName(patch.database);
        if (!cleanName(curr.sourceSchema) || cleanName(curr.sourceSchema) === previousDatabase) {
          next.sourceSchema = nextDatabase;
        }
      }
      return next;
    });
  }

  function patchTarget(patch) {
    setWorkspace((curr) => ({ ...curr, targetConnection: { ...curr.targetConnection, ...patch, pooler: { ...curr.targetConnection.pooler, ...(patch.pooler || {}) } } }));
  }

  async function fetchSourceSchemas() {
    await withBusy('source-schemas', async () => {
      const resp = await api('/connections/source/schemas', { method: 'POST', body: { sourceConnection: source } });
      const fallbackSchema = mysqlSchemaFallback(source);
      const schemas = uniqueCleanNames([fallbackSchema, ...(resp.schemas || [])]);
      setSourceSchemas(schemas);
      if (!workspace.sourceSchema && (schemas.length || fallbackSchema)) {
        const selectedSchema = schemas.includes(fallbackSchema) ? fallbackSchema : (schemas[0] || fallbackSchema);
        setWorkspace((curr) => ({ ...curr, sourceSchema: selectedSchema }));
      }
      setMessage('Loaded MySQL schemas');
    });
  }

  async function fetchTargetSchemas() {
    await withBusy('target-schemas', async () => {
      const resp = await api('/connections/target/schemas', { method: 'POST', body: { targetConnection: target } });
      const schemas = uniqueCleanNames(resp.schemas || []);
      setTargetSchemas(schemas);
      if (!workspace.targetSchema && schemas.length) {
        setWorkspace((curr) => ({ ...curr, targetSchema: schemas[0] }));
      }
      setMessage('Loaded PostgreSQL schemas');
    });
  }

  return (
    <div className="grid" style={{ alignItems: 'start' }}>
      <div className="card">
        <SectionTitle
          title="Source MySQL"
          hint="Provide the source database connection. In MySQL, schema means the database name; there is no nested schema namespace like PostgreSQL."
          action={<button className="btn" type="button" onClick={() => void fetchSourceSchemas()} disabled={busy['source-schemas']}>{busy['source-schemas'] ? 'Loading…' : 'Load schemas'}</button>}
        />
        <div className="form-grid">
          <div className="field"><div className="field-label">Host</div><input value={source.host} onChange={(e) => patchSource({ host: e.target.value })} /></div>
          <div className="field"><div className="field-label">Port</div><input type="number" value={source.port} onChange={(e) => patchSource({ port: Number(e.target.value || 3306) })} /></div>
          <div className="field"><div className="field-label">User</div><input value={source.user} onChange={(e) => patchSource({ user: e.target.value })} /></div>
          <div className="field"><div className="field-label">Database</div><input value={source.database} onChange={(e) => patchSource({ database: e.target.value })} /></div>
          <div className="field"><div className="field-label">SSL mode</div><select value={source.sslMode} onChange={(e) => patchSource({ sslMode: e.target.value })}><option>PREFERRED</option><option>REQUIRED</option><option>DISABLED</option><option>VERIFY_CA</option><option>VERIFY_IDENTITY</option></select><div className="hint" style={{ marginTop: 6 }}>For local/phpMyAdmin MySQL, use DISABLED unless your server explicitly requires SSL. VERIFY modes need proper CA/cert support.</div></div>
          <label className="check"><input type="checkbox" checked={source.consistentRead?.enabled === true} onChange={(e) => patchSource({ consistentRead: { ...(source.consistentRead || {}), enabled: e.target.checked } })} /><span className="field-label" style={{ margin: 0 }}>Consistent read</span></label>
          <div className="field"><div className="field-label">Read isolation</div><select value={source.consistentRead?.isolation || 'REPEATABLE READ'} onChange={(e) => patchSource({ consistentRead: { ...(source.consistentRead || {}), isolation: e.target.value } })} disabled={source.consistentRead?.enabled !== true}><option>READ COMMITTED</option><option>REPEATABLE READ</option><option>SERIALIZABLE</option></select><div className="hint" style={{ marginTop: 6 }}>Only used when Consistent read is checked. REPEATABLE READ is usually best for stable migration snapshots.</div></div>
          <div className="field"><div className="field-label">Connection label / Reference</div><input value={source.ref || ''} onChange={(e) => patchSource({ ref: e.target.value })} placeholder="optional label, e.g. local-mysql" /><div className="hint" style={{ marginTop: 6 }}>Optional label only. It does not affect the database connection.</div></div>
          <div className="field full"><div className="field-label">Password</div><input type="password" value={source.password} onChange={(e) => patchSource({ password: e.target.value })} /></div>
          <div className="field full"><div className="field-label">SSL CA</div><textarea rows={3} value={source.sslCa || ''} onChange={(e) => patchSource({ sslCa: e.target.value })} placeholder="optional PEM CA certificate" /></div>
          <div className="field full"><div className="field-label">SSL client certificate</div><textarea rows={3} value={source.sslCert || ''} onChange={(e) => patchSource({ sslCert: e.target.value })} placeholder="optional PEM client certificate" /></div>
          <div className="field full"><div className="field-label">SSL private key</div><textarea rows={3} value={source.sslKey || ''} onChange={(e) => patchSource({ sslKey: e.target.value })} placeholder="optional PEM private key; not saved locally" /></div>
          <div className="field full"><div className="field-label">Connection string</div><input value={source.connectionString || ''} onChange={(e) => patchSource({ connectionString: e.target.value })} placeholder="optional mysql://... URL" /></div>
          <div className="field full"><div className="field-label">Database / Schema</div><select value={effectiveSourceSchema} onChange={(e) => setWorkspace((curr) => ({ ...curr, sourceSchema: e.target.value }))}><option value="">— select source database/schema —</option>{uniqueCleanNames([source.database, effectiveSourceSchema, ...sourceSchemas]).map((schema) => <option key={schema} value={schema}>{schema}</option>)}</select><div className="hint" style={{ marginTop: 6 }}>For MySQL this is normally the same value as the Database field above. The database name is included even before schema listing finishes.</div></div>
        </div>
      </div>

      <div className="card">
        <SectionTitle
          title="Target PostgreSQL"
          hint="Use either a connection string or pooler fields. Password is not persisted."
          action={<button className="btn" type="button" onClick={() => void fetchTargetSchemas()} disabled={busy['target-schemas']}>{busy['target-schemas'] ? 'Loading…' : 'Load schemas'}</button>}
        />
        <div className="form-grid">
          <div className="field full"><div className="field-label">Connection string</div><input value={target.connectionString || ''} onChange={(e) => patchTarget({ connectionString: e.target.value })} placeholder="postgres://..." /></div>
          <div className="field"><div className="field-label">Host</div><input value={target.pooler.host} onChange={(e) => patchTarget({ pooler: { host: e.target.value } })} /></div>
          <div className="field"><div className="field-label">Port</div><input type="number" value={target.pooler.port} onChange={(e) => patchTarget({ pooler: { port: Number(e.target.value || 5432) } })} /></div>
          <div className="field"><div className="field-label">User</div><input value={target.pooler.user} onChange={(e) => patchTarget({ pooler: { user: e.target.value } })} /></div>
          <div className="field"><div className="field-label">Database</div><input value={target.pooler.database} onChange={(e) => patchTarget({ pooler: { database: e.target.value } })} /></div>
          <div className="field"><div className="field-label">SSL mode</div><select value={target.pooler.sslmode} onChange={(e) => patchTarget({ pooler: { sslmode: e.target.value } })}><option value="disable">disable</option><option value="allow">allow</option><option value="prefer">prefer</option><option value="require">require</option><option value="verify-ca">verify-ca</option><option value="verify-full">verify-full</option><option value="no-verify">no-verify</option></select><div className="hint" style={{ marginTop: 6 }}>Supabase usually needs require/no-verify depending on your connection string. Local PostgreSQL often uses disable/prefer.</div></div>
          <div className="field"><div className="field-label">Connection label / Reference</div><input value={target.ref || ''} onChange={(e) => patchTarget({ ref: e.target.value })} placeholder="optional label, e.g. supabase-staging" /><div className="hint" style={{ marginTop: 6 }}>Optional label only. It does not affect the database connection.</div></div>
          <div className="field full"><div className="field-label">Password</div><input type="password" value={target.pooler.password || ''} onChange={(e) => patchTarget({ pooler: { password: e.target.value } })} /></div>
          <div className="field full"><div className="field-label">Schema</div><select value={workspace.targetSchema} onChange={(e) => setWorkspace((curr) => ({ ...curr, targetSchema: e.target.value }))}><option value="">— select target schema —</option>{uniqueCleanNames(targetSchemas).map((schema) => <option key={schema} value={schema}>{schema}</option>)}</select></div>
          <label className="check full" style={{ gridColumn: 'span 12' }}>
            <input type="checkbox" checked={workspace.includeViews} onChange={(e) => setWorkspace((curr) => ({ ...curr, includeViews: e.target.checked }))} />
            <span className="field-label" style={{ margin: 0 }}>Include views during schema introspection</span>
          </label>
        </div>
      </div>
    </div>
  );
}

function WorkspaceScreen() {
  const { workspace, setWorkspace, projects, introspection, setIntrospection, currentProject, setCurrentProject, selectedProjectId, setSelectedProjectId, refreshProjects, loadProject, withBusy, busy, setMessage, setTab, setMappingDirty, clearProjectDerivedState } = useApp();
  const [projectMode, setProjectMode] = useState(() => selectedProjectId ? 'existing' : 'new');
  const workspaceIsSavedProject = workspaceMatchesProject(workspace, currentProject);
  const projectStateLabel = workspaceIsSavedProject && currentProject?.id
    ? `Editing saved project ${currentProject.id}`
    : 'New unsaved project draft';
  const selectedSavedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const savedProjectMappingCount = selectedSavedProject?.mappingSummary?.mappedTables
    ?? selectedSavedProject?.tableMappings?.filter?.((mapping) => mapping?.targetTable)?.length
    ?? 0;

  async function introspect() {
    await withBusy('introspect', async () => {
      const payload = workspaceForCatalogRequest(workspace);
      setWorkspace(payload);
      const resp = await api('/introspect', { method: 'POST', body: payload, timeoutMs: 120000 });
      setIntrospection(resp);
      setMessage('Schema introspection completed');
    });
  }

  async function saveWorkspaceProject({ openMapping = false } = {}) {
    const busyKey = openMapping ? 'continue-mapping' : 'save-workspace-project';
    await withBusy(busyKey, async () => {
      const payload = workspaceForCatalogRequest(workspace);
      setWorkspace(payload);
      if (!introspection?.source || !introspection?.target) {
        throw new Error('Click “Introspect schemas” first so the source and target catalogs are visible before saving the project.');
      }
      const sourceCatalog = normalizeCatalog(introspection.source || {});
      const targetCatalog = normalizeCatalog(introspection.target || {});
      const startFresh = !workspaceMatchesProject(payload, currentProject) || isProjectNameChanged(payload.name, currentProject);
      if (startFresh) {
        clearProjectDerivedState({ keepIntrospection: true, keepMessage: true });
      }
      const existingMappings = startFresh ? [] : (currentProject?.tableMappings || []);
      const resp = startFresh
        ? await api('/projects/import', {
          method: 'POST',
          body: buildManualProjectPayload({ workspace: payload, introspection: { source: sourceCatalog, target: targetCatalog }, tableMappings: [] }),
          timeoutMs: 120000,
        })
        : await api(`/projects/${encodeURIComponent(currentProject.id)}`, {
          method: 'PUT',
          body: {
            name: payload.name || currentProject.name,
            notes: currentProject.notes || '',
            sourceSchema: payload.sourceSchema,
            targetSchema: payload.targetSchema,
            includeViews: payload.includeViews,
            sourceCatalog,
            targetCatalog,
            tableMappings: existingMappings,
          },
          timeoutMs: 120000,
        });
      const project = normalizeProjectForUi(resp.project || null);
      setCurrentProject(project || null);
      setSelectedProjectId(project?.id || '');
      setMappingDirty(false);
      await refreshProjects();
      setMessage(`${startFresh ? 'Saved new manual migration project' : 'Saved inspected schemas'} for ${project?.name || ''}`.trim());
      if (openMapping) setTab('mapping');
    });
  }

  async function openExistingProject(projectId = selectedProjectId, { openMapping = false } = {}) {
    const id = cleanName(projectId);
    await withBusy(openMapping ? 'open-existing-mapping' : 'load-existing-project', async () => {
      if (!id) throw new Error('Select an existing migration project first.');
      const project = await loadProject(id, { loadIntoWorkspace: true });
      setProjectMode('existing');
      setMessage(`Loaded saved migration ${project?.name || id} (${project?.id || id})`.trim());
      if (openMapping) setTab('mapping');
    });
  }

  function startNewProject() {
    setProjectMode('new');
    clearProjectDerivedState();
    setWorkspace((curr) => normalizeWorkspaceState({
      ...curr,
      name: `migration-${new Date().toISOString().slice(0, 10)}`,
    }));
    setMessage('Started a fresh migration workspace. Enter a new project name and introspect again.');
    setTab('workspace');
  }

  function clearLocalCredentials() {
    const safeWorkspace = stripWorkspaceSecrets(workspace);
    setWorkspace((curr) => normalizeWorkspaceState(stripWorkspaceSecrets(curr)));
    try {
      localStorage.setItem(getStorageKey('workspace'), JSON.stringify(safeWorkspace));
    } catch {
      // ignore
    }
    setMessage('Local connection secrets cleared.');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Connect & introspect" hint="Choose a new or saved migration, then continue with schema inspection and mapping." action={<span className="badge">Step 1</span>} />
        <div className="toolbar" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
          <div className="tabs" role="tablist" aria-label="Migration mode">
            <button className="tab" type="button" role="tab" aria-selected={projectMode === 'new'} onClick={startNewProject}>New migration</button>
            <button className="tab" type="button" role="tab" aria-selected={projectMode === 'existing'} onClick={() => { setProjectMode('existing'); void refreshProjects(); }}>Existing migration</button>
          </div>
          {projectMode === 'existing' ? (
            <div className="toolbar" style={{ flex: 1, minWidth: 280 }}>
              <select
                value={selectedProjectId}
                onChange={(e) => {
                  setSelectedProjectId(e.target.value);
                  if (e.target.value) void openExistingProject(e.target.value);
                }}
                disabled={busy['load-existing-project']}
                aria-label="Existing migration project"
                style={{ minWidth: 320, flex: 1 }}
              >
                <option value="">— Select saved migration —</option>
                {projects.map((project) => {
                  const count = project.mappingSummary?.mappedTables ?? project.tableMappings?.filter?.((mapping) => mapping?.targetTable)?.length ?? 0;
                  return (
                    <option key={project.id} value={project.id}>
                      {project.name || project.id} ({project.id}.json, {count} mapped)
                    </option>
                  );
                })}
              </select>
              <button className="btn" type="button" onClick={() => void refreshProjects()}>Refresh</button>
              <button className="btn primary" type="button" onClick={() => void openExistingProject()} disabled={!selectedProjectId || busy['load-existing-project']}>{busy['load-existing-project'] ? 'Loading…' : 'Load selected'}</button>
              <button className="btn" type="button" onClick={() => void openExistingProject(selectedProjectId, { openMapping: true })} disabled={!selectedProjectId || busy['open-existing-mapping']}>{busy['open-existing-mapping'] ? 'Opening…' : 'Open Mapping'}</button>
            </div>
          ) : null}
        </div>
        {projectMode === 'existing' && selectedSavedProject ? (
          <div className="alert" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800 }}>{selectedSavedProject.name || selectedSavedProject.id}</div>
            <div className="hint" style={{ marginTop: 6 }}>File: {selectedSavedProject.id}.json • Source: {selectedSavedProject.sourceSchema || '—'} • Target: {selectedSavedProject.targetSchema || '—'} • Mapped tables: {savedProjectMappingCount}</div>
          </div>
        ) : null}
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <span className="badge">{projectStateLabel}</span>
          {currentProject?.id && !workspaceIsSavedProject ? <span className="hint">Saving this draft will create a separate project with empty mappings.</span> : null}
        </div>
        <div className="field full" style={{ marginBottom: 14 }}>
          <div className="field-label">Project name</div>
          <input value={workspace.name} onChange={(e) => setWorkspace((curr) => ({ ...curr, name: e.target.value }))} placeholder="e.g. billing-mysql-to-pg" />
        </div>
        <FirstRunChecklist />
        <div style={{ height: 16 }} />
        <ConnectionFields />
        <div style={{ height: 16 }} />
        <div className="alert" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800 }}>Manual mapping only</div>
          <div className="hint" style={{ marginTop: 6 }}>This step stores the project name and inspected catalogs. You will manually define table and column mappings in the Mapping tab.</div>
        </div>
        <div className="toolbar">
          <button className="btn" type="button" onClick={() => void introspect()} disabled={busy.introspect}>{busy.introspect ? 'Introspecting…' : 'Introspect schemas'}</button>
          <button className="btn" type="button" onClick={() => void saveWorkspaceProject()} disabled={!introspection || busy['save-workspace-project']}>{busy['save-workspace-project'] ? 'Saving…' : 'Save project'}</button>
          <button className="btn primary" type="button" onClick={() => void saveWorkspaceProject({ openMapping: true })} disabled={!introspection || busy['continue-mapping']}>{busy['continue-mapping'] ? 'Saving…' : 'Save & open Mapping'}</button>
          <button className="btn" type="button" onClick={clearLocalCredentials}>Clear local credentials</button>
          <button className="btn" type="button" onClick={startNewProject}>New project</button>
          {!introspection ? <span className="hint">Run introspection first; saving will store the shown catalogs into a project.</span> : null}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>New project names start with empty mappings and cleared validation/run state. Use project selection only when you want to reuse an existing saved migration.</div>
      </div>

      {introspection ? (
        <div className="grid" style={{ alignItems: 'start' }}>
          <CatalogPreview title="Source catalog" catalog={introspection.source || {}} />
          <CatalogPreview title="Target catalog" catalog={introspection.target || {}} />
        </div>
      ) : null}
    </div>
  );
}

function ProjectStatusBadge() {
  const { tab, workspace, currentProject } = useApp();
  const draftName = cleanName(workspace?.name);
  const isDraft = draftName && !workspaceMatchesProject(workspace, currentProject);
  if ((tab === 'workspace' || isDraft) && draftName) {
    return <span className="badge">Project draft: {draftName}</span>;
  }
  if (currentProject?.name) {
    return <span className="badge">Project: {currentProject.name}</span>;
  }
  return null;
}

function MappingScreen() {
  const { workspace, currentProject, setCurrentProject, selectedProjectId, projects, setSelectedProjectId, refreshProjects, loadProject, withBusy, busy, setMessage, setError, introspection, transformCatalog, mappingDirty, setMappingDirty, setTab } = useApp();
  const [schemaPlan, setSchemaPlan] = useState(null);
  const [manualAdd, setManualAdd] = useState({ sourceTable: '', targetTable: '', mode: 'existing' });

  async function saveProject() {
    if (!currentProject?.id) return;
    await withBusy('save-project', async () => {
      const dedupedTableMappings = dedupeTableMappings(currentProject.tableMappings || []);
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}`, {
        method: 'PUT',
        body: {
          name: currentProject.name,
          notes: currentProject.notes || '',
          sourceSchema: currentProject.sourceSchema || workspace.sourceSchema,
          targetSchema: currentProject.targetSchema || workspace.targetSchema,
          includeViews: currentProject.includeViews ?? workspace.includeViews,
          sourceCatalog,
          targetCatalog,
          tableMappings: dedupedTableMappings,
        },
        timeoutMs: 120000,
      });
      setCurrentProject(normalizeProjectForUi(resp.project || null));
      setMappingDirty(false);
      await refreshProjects();
      setMessage('Saved project mappings');
    });
  }

  async function saveAndContinue() {
    await saveProject();
    setTab('transform');
  }

  async function generateSchemaPlan() {
    if (!currentProject?.id) return;
    await withBusy('schema-plan', async () => {
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}/schema-plan`, { method: 'POST', timeoutMs: 120000 });
      setSchemaPlan(resp.plan || null);
      setMessage('Generated target schema plan');
    });
  }

  async function provisionTarget() {
    if (!currentProject?.id) return;
    await withBusy('provision-target', async () => {
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}/provision-target`, {
        method: 'POST',
        body: { targetConnection: workspace.targetConnection },
        timeoutMs: 120000,
      });
      setSchemaPlan(resp.plan || null);
      setCurrentProject(normalizeProjectForUi(resp.project || null));
      await refreshProjects();
      setMessage(`Provisioned ${resp.created?.length || 0} target tables`);
    });
  }

  function patchTable(index, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next[index] = { ...next[index], ...patch };
      return { ...curr, tableMappings: next };
    });
  }

  function patchColumn(tableIndex, colIndex, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const columnMappings = [...(table.columnMappings || [])];
      columnMappings[colIndex] = { ...columnMappings[colIndex], ...patch };
      table.columnMappings = columnMappings;
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function clearTargetDependentSelections(mapping) {
    return {
      conflictKeys: [],
      columnMappings: (mapping.columnMappings || []).map((column) => ({
        ...column,
        targetColumn: null,
        targetColumnMode: column.targetColumnMode === 'ignore' ? 'ignore' : 'existing',
      })),
    };
  }

  function patchLoadStrategy(tableIndex, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      table.loadStrategy = {
        mode: 'historical_full',
        persistWatermark: true,
        lookbackAmount: 0,
        lookbackUnit: 'minutes',
        deleteHandling: { mode: 'none', column: '' },
        ...(table.loadStrategy || {}),
        ...patch,
      };
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function patchHistoricalFilter(tableIndex, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const loadStrategy = table.loadStrategy || { mode: 'historical_full' };
      table.loadStrategy = {
        ...loadStrategy,
        historicalFilter: {
          enabled: false,
          column: '',
          operator: '>=',
          value: '',
          valueTo: '',
          ...(loadStrategy.historicalFilter || {}),
          ...patch,
        },
      };
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function patchDeleteHandling(tableIndex, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const loadStrategy = table.loadStrategy || { mode: 'historical_full' };
      table.loadStrategy = {
        ...loadStrategy,
        deleteHandling: { mode: 'none', column: '', ...(loadStrategy.deleteHandling || {}), ...patch },
      };
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function removeColumnMapping(tableIndex, colIndex) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const columnMappings = [...(table.columnMappings || [])];
      columnMappings.splice(colIndex, 1);
      table.columnMappings = columnMappings;
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function addColumnMapping(tableIndex) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const sourceTable = tableByName(curr.sourceCatalog, table.sourceTable) || tableByName(sourceCatalog, table.sourceTable);
      const used = new Set((table.columnMappings || []).map((item) => item.sourceColumn).filter(Boolean));
      const sourceColumns = tableColumns(sourceTable);
      const nextSourceColumn = sourceColumns.find((column) => !used.has(column.name))?.name || sourceColumns[0]?.name || '';
      table.columnMappings = [...(table.columnMappings || []), createBlankColumnMapping(table.sourceTable, nextSourceColumn, table.columnMappings?.length || 0)];
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function addAllSourceColumns(tableIndex) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const sourceTable = tableByName(curr.sourceCatalog, table.sourceTable) || tableByName(sourceCatalog, table.sourceTable);
      const used = new Set((table.columnMappings || []).map((item) => item.sourceColumn).filter(Boolean));
      const additions = tableColumns(sourceTable)
        .filter((column) => !used.has(column.name))
        .map((column, index) => createBlankColumnMapping(table.sourceTable, column.name, (table.columnMappings?.length || 0) + index));
      table.columnMappings = [...(table.columnMappings || []), ...additions];
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function clearColumnMappings(tableIndex) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      tableMappings[tableIndex] = { ...tableMappings[tableIndex], columnMappings: [] };
      return { ...curr, tableMappings };
    });
  }

  function getColumnTargetMode(tableMapping, columnMapping) {
    if (columnMapping.targetColumnMode) return columnMapping.targetColumnMode;
    if (columnMapping.enabled === false || !columnMapping.targetColumn) return 'ignore';
    const targetTable = tableByName(targetCatalog, tableMapping.targetTable);
    if (columnByName(targetTable, columnMapping.targetColumn)) return 'existing';
    return 'create_new';
  }

  function patchColumnTargetMode(tableIndex, colIndex, mode) {
    const tableMapping = currentProject?.tableMappings?.[tableIndex];
    const columnMapping = tableMapping?.columnMappings?.[colIndex];
    const targetTable = tableByName(targetCatalog, tableMapping?.targetTable);
    const currentTargetIsExisting = columnByName(targetTable, columnMapping?.targetColumn);
    if (mode === 'ignore') {
      patchColumn(tableIndex, colIndex, { enabled: false, targetColumn: null, targetColumnMode: 'ignore' });
    } else if (mode === 'existing') {
      patchColumn(tableIndex, colIndex, { enabled: true, targetColumn: currentTargetIsExisting ? columnMapping.targetColumn : '', targetColumnMode: 'existing' });
    } else {
      patchColumn(tableIndex, colIndex, { enabled: true, targetColumn: currentTargetIsExisting ? '' : (columnMapping?.targetColumn || ''), targetColumnMode: 'create_new' });
    }
  }

  function addManualTableMapping() {
    const sourceTableName = String(manualAdd.sourceTable || '').trim();
    if (!sourceTableName) {
      setError('Select a MySQL source table before clicking Add mapping. If the dropdown is empty, click Preview / introspect schemas in Workspace, then return to Mapping.');
      return;
    }
    if (!tableByName(sourceCatalog, sourceTableName)) {
      setError(`Source table "${sourceTableName}" is not available in the current project catalog. Refresh/recreate the project from Workspace.`);
      return;
    }
    const targetMode = manualAdd.mode || 'existing';
    const targetTableName = targetMode === 'create_new'
      ? String(manualAdd.targetTable || sourceTableName).trim()
      : String(manualAdd.targetTable || '').trim();
    const duplicateExists = (currentProject?.tableMappings || []).some((mapping) => cleanName(mapping.sourceTable) === sourceTableName && cleanName(mapping.targetTable) === cleanName(targetTableName || null));
    if (duplicateExists) {
      setError(`A table mapping for ${sourceTableName} → ${targetTableName || '—'} already exists in this project. Remove the duplicate instead of adding it again.`);
      return;
    }
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next.push({
        id: `${sourceTableName}:${Date.now()}`,
        sourceTable: sourceTableName,
        targetTable: targetTableName || null,
        targetTableMode: targetMode,
        createTargetTable: targetMode === 'create_new',
        enabled: true,
        conflictStrategy: 'insert',
        conflictKeys: [],
        chunkSize: 500,
        writeMode: 'append',
        order: next.length,
        columnMappings: [],
      });
      return { ...curr, tableMappings: next };
    });
    setMappingDirty(true);
    setManualAdd({ sourceTable: '', targetTable: '', mode: 'existing' });
  }

  function removeTableMapping(index) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next.splice(index, 1);
      return { ...curr, tableMappings: next.map((item, order) => ({ ...item, order })) };
    });
  }

  const sourceCatalog = resolveCatalog(currentProject?.sourceCatalog, introspection?.source);
  const targetCatalog = resolveCatalog(currentProject?.targetCatalog, introspection?.target);
  const sourceTables = catalogTables(sourceCatalog);
  const targetTables = catalogTables(targetCatalog);
  const targetTableNames = uniqueCleanNames(targetTables.map((table) => table.name));
  const sourceTableNames = uniqueCleanNames(sourceTables.map((table) => table.name));
  const verificationReady = currentProject?.tableMappings?.every((mapping) => {
    if (mapping.enabled === false) return true;
    if (!mapping.sourceTable) return false;
    if (!mapping.targetTable && mapping.targetTableMode !== 'create_new') return false;
    return true;
  });

  function renderSchemaPlanSummary(plan) {
    if (!plan) return '—';
    const total = Array.isArray(plan.tables) ? plan.tables.length : 0;
    const create = plan.summary?.createTableCount || 0;
    const alter = plan.summary?.alterTableCount || 0;
    const incompatible = plan.summary?.incompatibleTableCount || 0;
    const existing = plan.summary?.existingTableCount || 0;
    return `Tables: ${total} • Create: ${create} • Alter: ${alter} • Use existing: ${existing} • Manual fixes: ${incompatible}`;
  }

  function renderCompatibilitySummary(item) {
    const compatible = item?.compatibleColumns || [];
    const incompatible = item?.incompatibleColumns || [];
    const classes = new Map();
    for (const column of compatible) {
      const klass = column.compatibilityClass || column.comparison?.compatibilityClass || 'direct';
      classes.set(klass, (classes.get(klass) || 0) + 1);
    }
    if (incompatible.length) classes.set('blocked', incompatible.length);
    const summary = Array.from(classes.entries()).map(([key, count]) => `${key}:${count}`).join(' • ');
    const reviews = compatible
      .filter((column) => column.state === 'compatible_with_review' || (column.comparison?.reviewReasons || []).length)
      .slice(0, 3)
      .map((column) => `${column.name}: ${(column.comparison?.reviewReasons || []).slice(0, 2).join(', ') || column.comparison?.compatibilityClass || 'review'}`);
    return [summary || '—', ...reviews].join(reviews.length ? ' | ' : '');
  }

  function renderIssueSummary(issues = []) {
    if (!issues.length) return '—';
    return issues.map((issue) => issue.message || issue.kind || String(issue)).join(' • ');
  }

  function badgeForColumnState(state) {
    if (state === 'ready' || state === 'compatible') return 'Ready';
    if (state === 'ready_with_transform' || state === 'transform_required') return 'Transform';
    if (state === 'provisioned') return 'Provision';
    if (state === 'risky') return 'Risky';
    if (state === 'unmapped') return 'Unmapped';
    if (state === 'missing_source') return 'Missing source';
    if (state === 'blocked') return 'Blocked';
    if (state === 'disabled') return 'Disabled';
    return state || '—';
  }

  function mappingRiskSummary(mapping) {
    const warnings = [];
    if (mapping.writeMode === 'append') warnings.push('Append mode can duplicate rows on retry/resume unless target uniqueness prevents it.');
    if (mapping.writeMode === 'truncate') warnings.push('Truncate mode is safest when rerun from the start after interruption.');
    if (mapping.writeMode === 'upsert' && !(mapping.conflictKeys || []).length) warnings.push('Upsert requires valid conflict keys.');
    if (mapping.writeMode === 'upsert' && (mapping.conflictKeys || []).length) warnings.push(`Conflict keys: ${(mapping.conflictKeys || []).join(', ')}`);
    if (mapping.watermarkColumn) warnings.push(`Watermark column configured: ${mapping.watermarkColumn}`);
    return warnings;
  }

  function patchTransformConfig(tableIndex, colIndex, key, value) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const columnMappings = [...(table.columnMappings || [])];
      const current = columnMappings[colIndex] || {};
      columnMappings[colIndex] = {
        ...current,
        transform: {
          ...(current.transform || { type: 'direct', config: {} }),
          config: {
            ...((current.transform && current.transform.config) || {}),
            [key]: value,
          },
        },
      };
      table.columnMappings = columnMappings;
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function patchRowFilter(tableIndex, patch) {
    setMappingDirty(true);
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      tableMappings[tableIndex] = {
        ...tableMappings[tableIndex],
        rowFilter: { ...(tableMappings[tableIndex].rowFilter || { enabled: false, expression: '', config: {} }), ...patch },
      };
      return { ...curr, tableMappings };
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Manual mappings" hint="Define source → target table mappings, source → target column intent, and load/write options before transformation." action={<span className="badge">Step 2</span>} />
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <select value={selectedProjectId} onChange={(e) => { setSelectedProjectId(e.target.value); void loadProject(e.target.value); }}>
            <option value="">— Select project —</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.id})</option>)}
          </select>
          {mappingDirty ? <span className="badge" style={{ borderColor: '#d97706', color: '#d97706' }}>Unsaved mapping changes</span> : <span className="badge">Mappings saved</span>}
          <button className="btn" type="button" onClick={() => void saveProject()} disabled={!currentProject?.id || busy['save-project']}>{busy['save-project'] ? 'Saving…' : 'Save mappings'}</button>
          <button className="btn primary" type="button" onClick={() => void saveAndContinue()} disabled={!currentProject?.id || busy['save-project']}>{busy['save-project'] ? 'Saving…' : 'Save & continue to Transform'}</button>
        </div>

        {!currentProject ? (
          <div className="hint">Create or load a project from the Workspace tab first.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!mappingDirty ? <MappingSummaryCard project={currentProject} sourceCatalog={sourceCatalog} targetCatalog={targetCatalog} title="Saved mapping summary" hint="This is the currently persisted table and column mapping summary that will be used by validation and execution." /> : null}
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <SectionTitle title="Add manual table mapping" hint="Select existing tables from introspected schema lists. Type only when creating a new target table." />
              <div className="form-grid">
                <div className="field"><div className="field-label">Source table</div><select value={manualAdd.sourceTable} onChange={(e) => setManualAdd((curr) => ({ ...curr, sourceTable: e.target.value }))}><option value="">— select source table —</option>{sourceTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
                <div className="field"><div className="field-label">Target table mode</div><select value={manualAdd.mode} onChange={(e) => setManualAdd((curr) => ({ ...curr, mode: e.target.value }))}><option value="existing">use existing</option><option value="create_new">create new</option></select></div>
                <div className="field"><div className="field-label">Target table</div>{manualAdd.mode === 'create_new' ? <input value={manualAdd.targetTable} onChange={(e) => setManualAdd((curr) => ({ ...curr, targetTable: e.target.value }))} placeholder={manualAdd.sourceTable || 'new target table name'} /> : <select value={manualAdd.targetTable} onChange={(e) => setManualAdd((curr) => ({ ...curr, targetTable: e.target.value }))}><option value="">— select target table —</option>{targetTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</select>}</div>
                <div className="field" style={{ justifyContent: 'flex-end' }}><div className="field-label" style={{ opacity: 0 }}>.</div><button className="btn primary" type="button" onClick={addManualTableMapping}>Add mapping</button></div>
              </div>
            </div>

            <div className="field full">
              <div className="field-label">Notes</div>
              <textarea value={currentProject.notes || ''} onChange={(e) => { setMappingDirty(true); setCurrentProject((curr) => ({ ...curr, notes: e.target.value })); }} style={{ minHeight: 90 }} />
            </div>

            <div className="alert" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 800 }}>Mapping readiness</div>
              <div className="hint" style={{ marginTop: 6 }}>{verificationReady ? 'Basic mapping completeness looks OK. You can proceed to verification.' : 'Some enabled mappings still need source/target table decisions before verification/load.'}</div>
            </div>
            <div className="alert warn" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 800 }}>Manual mapping only</div>
              <div className="hint" style={{ marginTop: 6 }}>Add at least one source → target table mapping, then save mappings before validation.</div>
            </div>

            {(currentProject.tableMappings || []).map((mapping, tableIndex) => (
              <div key={mapping.id} className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{mapping.sourceTable || 'Unselected source table'} → {mapping.targetTable || (mapping.targetTableMode === 'create_new' ? 'new target table' : 'target not selected')}</div>
                    <div className="hint">Manual table mapping. Review source table, target table, column mappings, write mode, and load strategy.</div>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={mapping.enabled !== false} onChange={(e) => patchTable(tableIndex, { enabled: e.target.checked })} />
                    <span className="field-label" style={{ margin: 0 }}>Enabled</span>
                  </label>
                  <button className="btn danger" type="button" onClick={() => removeTableMapping(tableIndex)}>Remove</button>
                </div>

                <div className="form-grid" style={{ marginTop: 12 }}>
                  <div className="field"><div className="field-label">Source table</div><select value={mapping.sourceTable || ''} onChange={(e) => patchTable(tableIndex, { sourceTable: e.target.value, columnMappings: [] })}><option value="">— select source table —</option>{sourceTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
                  <div className="field"><div className="field-label">Target table mode</div><select value={mapping.targetTableMode || 'existing'} onChange={(e) => patchTable(tableIndex, { targetTableMode: e.target.value, createTargetTable: e.target.value === 'create_new', conflictKeys: [] })}><option value="existing">use existing table</option><option value="create_new">create new table</option></select></div>
                  <div className="field"><div className="field-label">Target table</div>{(mapping.targetTableMode || 'existing') === 'create_new' ? <input value={mapping.targetTable || ''} onChange={(e) => patchTable(tableIndex, { targetTable: e.target.value || null, ...clearTargetDependentSelections(mapping) })} placeholder="new target table name" /> : <select value={mapping.targetTable || ''} onChange={(e) => patchTable(tableIndex, { targetTable: e.target.value || null, ...clearTargetDependentSelections(mapping) })}><option value="">— select target table —</option>{targetTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</select>}</div>
                </div>

                <div style={{ height: 12 }} />
                <div className="grid" style={{ alignItems: 'start' }}>
                  <div className="card" style={{ background: 'rgba(255,255,255,0.015)' }}>
                    <SectionTitle title="Source columns" hint={mapping.sourceTable ? `From ${mapping.sourceTable}` : 'Select a source table'} />
                    <div className="schema-table-scroll" style={{ maxHeight: 220, overflow: 'auto' }}>
                      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>{tableColumns(tableByName(sourceCatalog, mapping.sourceTable)).map((column) => <tr key={column.name}><td className="mono" style={{ padding: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{column.name}</td><td style={{ padding: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{describeColumn(column) || '—'}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </div>
                  <div className="card" style={{ background: 'rgba(255,255,255,0.015)' }}>
                    <SectionTitle title="Target columns" hint={mapping.targetTable ? `From ${mapping.targetTable}` : 'Select a target table'} />
                    <div className="schema-table-scroll" style={{ maxHeight: 220, overflow: 'auto' }}>
                      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>{tableColumns(tableByName(targetCatalog, mapping.targetTable)).map((column) => <tr key={column.name}><td className="mono" style={{ padding: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{column.name}</td><td style={{ padding: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{describeColumn(column) || '—'}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <div className="toolbar" style={{ marginTop: 12 }}>
                  <button className="btn" type="button" onClick={() => addColumnMapping(tableIndex)}>Add column mapping</button>
                  <button className="btn" type="button" onClick={() => addAllSourceColumns(tableIndex)}>Add all source columns</button>
                  <button className="btn danger" type="button" onClick={() => clearColumnMappings(tableIndex)}>Clear columns</button>
                </div>
                <div style={{ overflowX: 'auto', overflowY: 'visible', maxHeight: 'none', paddingRight: 4 }}>
                  <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Use</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Source column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Source type</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Target column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Target type</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Transform</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>State</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mapping.columnMappings || []).map((column, colIndex) => {
                        const sourceTable = tableByName(sourceCatalog, mapping.sourceTable);
                        const targetTable = tableByName(targetCatalog, mapping.targetTable);
                        const sourceColumn = columnByName(sourceTable, column.sourceColumn);
                        const targetColumn = columnByName(targetTable, column.targetColumn);
                        const targetMode = getColumnTargetMode(mapping, column);
                        return (
                        <tr key={column.id}>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><input type="checkbox" checked={column.enabled !== false} onChange={(e) => patchColumn(tableIndex, colIndex, { enabled: e.target.checked })} /></td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><select value={column.sourceColumn || ''} onChange={(e) => patchColumn(tableIndex, colIndex, { sourceColumn: e.target.value })}><option value="">— select source column —</option>{tableColumns(sourceTable).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></td>
                          <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{describeColumn(sourceColumn) || '—'}</td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                            <select value={targetMode} onChange={(e) => patchColumnTargetMode(tableIndex, colIndex, e.target.value)} style={{ marginBottom: 6 }}><option value="existing">existing target column</option><option value="create_new">create new target column</option><option value="ignore">ignore / unmapped</option></select>
                            {targetMode === 'ignore' ? <div className="hint">This source column will not be written.</div> : targetMode === 'create_new' ? <input value={column.targetColumn || ''} onChange={(e) => patchColumn(tableIndex, colIndex, { enabled: true, targetColumn: e.target.value || null })} placeholder="new target column" /> : <select value={column.targetColumn || ''} onChange={(e) => patchColumn(tableIndex, colIndex, { enabled: true, targetColumn: e.target.value || null })}><option value="">— select target column —</option>{tableColumns(targetTable).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>}
                          </td>
                          <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{targetMode === 'create_new' ? 'new column' : (describeColumn(targetColumn) || '—')}</td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                            <span className="badge">{column.transform?.preset || column.transform?.type || 'direct'}</span>
                            <div className="hint" style={{ marginTop: 6 }}>Configure in Transform.</div>
                          </td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{badgeForColumnState(column.columnState || column.state)}</td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><button className="btn danger" type="button" onClick={() => removeColumnMapping(tableIndex, colIndex)}>Remove</button></td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ height: 12 }} />
                {(() => {
                  const sourceTable = tableByName(sourceCatalog, mapping.sourceTable);
                  const sourceColumns = tableColumns(sourceTable);
                  const loadStrategy = mapping.loadStrategy || { mode: 'historical_full', persistWatermark: true, lookbackAmount: 0, lookbackUnit: 'minutes', deleteHandling: { mode: 'none' } };
                  const historicalFilter = loadStrategy.historicalFilter || { enabled: false, column: '', operator: '>=', value: '', valueTo: '' };
                  const deleteHandling = loadStrategy.deleteHandling || { mode: 'none', column: '' };
                  return (
                    <div className="card" style={{ background: 'rgba(59,130,246,0.06)' }}>
                      <SectionTitle title="Load strategy & write options" hint="Configure load/write behavior after table and column mapping decisions are visible." />
                      <div className="form-grid">
                        <div className="field"><div className="field-label">Write mode</div><select value={mapping.writeMode || 'append'} onChange={(e) => patchTable(tableIndex, { writeMode: e.target.value })}><option value="append">append</option><option value="truncate">truncate</option><option value="upsert">upsert</option></select></div>
                        <div className="field"><div className="field-label">Conflict strategy</div><select value={mapping.conflictStrategy || 'insert'} onChange={(e) => patchTable(tableIndex, { conflictStrategy: e.target.value })}><option value="insert">insert</option><option value="upsert">upsert</option><option value="truncate-load">truncate-load</option></select></div>
                        <div className="field"><div className="field-label">Chunk size</div><input type="number" value={mapping.chunkSize || 500} onChange={(e) => patchTable(tableIndex, { chunkSize: Number(e.target.value || 500) })} /></div>
                        <div className="field"><div className="field-label">Strategy</div><select value={loadStrategy.mode || 'historical_full'} onChange={(e) => patchLoadStrategy(tableIndex, { mode: e.target.value })}><option value="historical_full">historical full load</option><option value="historical_filtered">historical filtered load</option><option value="incremental_watermark">incremental watermark load</option><option value="historical_then_incremental">historical + then incremental</option></select></div>
                        <div className="field full"><div className="field-label">Conflict keys</div><select multiple value={mapping.conflictKeys || []} onChange={(e) => patchTable(tableIndex, { conflictKeys: Array.from(e.target.selectedOptions).map((option) => option.value).filter(Boolean) })} disabled={(mapping.targetTableMode || 'existing') === 'create_new' || !mapping.targetTable} style={{ minHeight: 92 }}>{tableColumns(tableByName(targetCatalog, mapping.targetTable)).map((column) => <option key={column.name} value={column.name}>{column.name} {describeColumn(column) ? `(${describeColumn(column)})` : ''}</option>)}</select><div className="hint" style={{ marginTop: 6 }}>Used for upsert conflict detection. Hold Cmd/Ctrl to select multiple columns.</div></div>
                        <div className="field"><div className="field-label">Watermark column</div><select value={loadStrategy.watermarkColumn || mapping.watermarkColumn || ''} onChange={(e) => { patchLoadStrategy(tableIndex, { watermarkColumn: e.target.value || undefined }); patchTable(tableIndex, { watermarkColumn: e.target.value || undefined }); }} disabled={!['incremental_watermark', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')}><option value="">— select watermark —</option>{sourceColumns.map((column) => <option key={column.name} value={column.name}>{column.name} {describeColumn(column) ? `(${describeColumn(column)})` : ''}</option>)}</select></div>
                        <div className="field"><div className="field-label">Tie-breaker column</div><select value={loadStrategy.tieBreakerColumn || ''} onChange={(e) => patchLoadStrategy(tableIndex, { tieBreakerColumn: e.target.value || undefined })} disabled={!['incremental_watermark', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')}><option value="">— auto/use primary key —</option>{sourceColumns.map((column) => <option key={column.name} value={column.name}>{column.name} {describeColumn(column) ? `(${describeColumn(column)})` : ''}</option>)}</select></div>
                        <div className="field"><div className="field-label">Lookback amount</div><input type="number" min="0" value={loadStrategy.lookbackAmount || 0} onChange={(e) => patchLoadStrategy(tableIndex, { lookbackAmount: Number(e.target.value || 0) })} disabled={!['incremental_watermark', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')} /></div>
                        <div className="field"><div className="field-label">Lookback unit</div><select value={loadStrategy.lookbackUnit || 'minutes'} onChange={(e) => patchLoadStrategy(tableIndex, { lookbackUnit: e.target.value })} disabled={!['incremental_watermark', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></div>
                        <label className="check"><input type="checkbox" checked={loadStrategy.persistWatermark !== false} onChange={(e) => patchLoadStrategy(tableIndex, { persistWatermark: e.target.checked })} disabled={!['incremental_watermark', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')} /><span className="field-label" style={{ margin: 0 }}>Persist watermark after successful load</span></label>
                        <div className="field"><div className="field-label">Historical filter</div><select value={historicalFilter.enabled ? 'enabled' : 'disabled'} onChange={(e) => patchHistoricalFilter(tableIndex, { enabled: e.target.value === 'enabled' })} disabled={!['historical_filtered', 'historical_then_incremental'].includes(loadStrategy.mode || 'historical_full')}><option value="disabled">disabled</option><option value="enabled">enabled</option></select></div>
                        <div className="field"><div className="field-label">Filter column</div><select value={historicalFilter.column || ''} onChange={(e) => patchHistoricalFilter(tableIndex, { column: e.target.value })} disabled={!historicalFilter.enabled}><option value="">— select column —</option>{sourceColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></div>
                        <div className="field"><div className="field-label">Filter operator</div><select value={historicalFilter.operator || '>='} onChange={(e) => patchHistoricalFilter(tableIndex, { operator: e.target.value })} disabled={!historicalFilter.enabled}><option value=">=">&gt;=</option><option value=">">&gt;</option><option value="<=">&lt;=</option><option value="<">&lt;</option><option value="=">=</option><option value="!=">!=</option><option value="between">between</option><option value="like">like</option><option value="is_null">is null</option><option value="is_not_null">is not null</option></select></div>
                        <div className="field"><div className="field-label">Filter value</div><input value={historicalFilter.value ?? ''} onChange={(e) => patchHistoricalFilter(tableIndex, { value: e.target.value })} disabled={!historicalFilter.enabled || ['is_null', 'is_not_null'].includes(historicalFilter.operator)} placeholder="2020-01-01 or 1000" /></div>
                        <div className="field"><div className="field-label">Filter end value</div><input value={historicalFilter.valueTo ?? ''} onChange={(e) => patchHistoricalFilter(tableIndex, { valueTo: e.target.value })} disabled={!historicalFilter.enabled || historicalFilter.operator !== 'between'} placeholder="2024-12-31 or 5000" /></div>
                        <div className="field"><div className="field-label">Delete handling</div><select value={deleteHandling.mode || 'none'} onChange={(e) => patchDeleteHandling(tableIndex, { mode: e.target.value })}><option value="none">none / hard deletes not captured</option><option value="soft_delete">soft-delete column</option></select></div>
                        <div className="field"><div className="field-label">Soft-delete column</div><select value={deleteHandling.column || ''} onChange={(e) => patchDeleteHandling(tableIndex, { column: e.target.value })} disabled={deleteHandling.mode !== 'soft_delete'}><option value="">— select soft-delete column —</option>{sourceColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></div>
                        <div className="field full"><div className="field-label">Row filter</div><div className="hint">{mapping.rowFilter?.enabled ? `Configured in Transform: ${mapping.rowFilter.expression || 'enabled'}` : 'Configure row filtering in Transform.'}</div></div>
                        <label className="check full" style={{ gridColumn: 'span 12' }}>
                          <input type="checkbox" checked={mapping.createTargetTable === true} onChange={(e) => patchTable(tableIndex, { createTargetTable: e.target.checked, targetTableMode: e.target.checked ? 'create_new' : 'existing' })} />
                          <span className="field-label" style={{ margin: 0 }}>Create target table if it does not exist</span>
                        </label>
                        <div className="field full"><div className="field-label">Operational notes</div><div className="hint">{mappingRiskSummary(mapping).join(' • ') || 'No special notes.'}</div></div>
                        <div className="field full"><div className="field-label">Strategy notes</div><div className="hint">Incremental loads use persisted project/table watermarks. For update-safe incremental loads, prefer upsert with valid conflict keys. Hard deletes are not captured by watermark mode.</div></div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}

        {currentProject ? (
          <div className="card" style={{ marginTop: 18 }}>
            <SectionTitle
              title="Target schema provisioning"
              hint="Preview PostgreSQL-compatible DDL for missing target tables and apply it when ready."
              action={<div className="toolbar"><button className="btn" type="button" onClick={() => void generateSchemaPlan()} disabled={busy['schema-plan']}>{busy['schema-plan'] ? 'Planning…' : 'Generate schema plan'}</button><button className="btn primary" type="button" onClick={() => void provisionTarget()} disabled={busy['provision-target']}>{busy['provision-target'] ? 'Provisioning…' : 'Provision target tables'}</button></div>}
            />
            <div className="hint" style={{ marginBottom: 12 }}>{renderSchemaPlanSummary(schemaPlan)}</div>
            {schemaPlan?.tables?.length ? (
              <div className="schema-table-scroll" style={{ marginBottom: 14 }}>
                <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 8 }}>Source</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Target</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Action</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Compatibility</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Missing columns</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Issues</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Constraints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schemaPlan.tables.map((item) => (
                      <tr key={`${item.sourceTable}:${item.targetTable}`}>
                        <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.sourceTable}</td>
                        <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.targetTable}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.action}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{renderCompatibilitySummary(item)}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(item.missingColumns || []).map((col) => col.name).join(', ') || '—'}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{renderIssueSummary(item.issues || [])}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(item.constraintsToCreate || []).map((c) => `${c.type}:${c.name}${c.autoApplySafe ? '' : ' (manual)'}`).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{schemaPlan ? formatJson(schemaPlan) : '—'}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatValueMap(values = {}) {
  return Object.entries(values || {}).map(([key, value]) => `${key}=${value == null ? '' : String(value)}`).join('\n');
}

function parseValueMap(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.includes('=') ? trimmed.indexOf('=') : trimmed.indexOf(':');
    if (separatorIndex < 0) {
      values[trimmed] = '';
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function commaList(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value || '');
}

function parseCommaList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function defaultTransformForType(type, column = {}) {
  if (type === 'lookup') return { type, config: { values: {}, defaultValue: '' } };
  if (type === 'lookup_table') return { type, config: { table: '', localColumn: column.sourceColumn || '', lookupColumn: '', valueColumn: '', missing: 'reject', defaultValue: '' } };
  if (type === 'expression') return { type, config: { expression: 'value', requiredColumns: [] } };
  if (type === 'constant') return { type, config: { value: '' } };
  if (type === 'template') return { type, config: { template: '', requiredColumns: [] } };
  if (type === 'concat') return { type, config: { fields: [], delimiter: ' ' } };
  if (type === 'coalesce') return { type, config: { fields: [] } };
  if (type === 'conditional') return { type, config: { branches: [], otherwise: { type: 'direct', config: {} } } };
  if (type === 'mojibake_repair') return { type, config: { mode: 'auto' } };
  return { type, config: {} };
}

function TransformScreen() {
  const { workspace, currentProject, setCurrentProject, selectedProjectId, transformPreview, setTransformPreview, refreshProjects, withBusy, busy, setMessage, setError, mappingDirty, setMappingDirty, setTab, transformCatalog } = useApp();
  const [sampleLimit, setSampleLimit] = useState(5);
  const sourceCatalog = resolveCatalog(currentProject?.sourceCatalog, null);
  const targetCatalog = resolveCatalog(currentProject?.targetCatalog, null);
  const sourceTables = catalogTables(sourceCatalog);
  const enabledMappings = (currentProject?.tableMappings || []).filter((mapping) => mapping.enabled !== false);
  const transformTypes = ['direct', 'string', 'number', 'boolean', 'json', 'date', 'datetime', 'constant', 'null', 'template', 'lookup', 'lookup_table', 'expression', 'concat', 'coalesce', 'conditional', 'mojibake_repair'];

  function markTransformDirty() {
    setMappingDirty(true);
    setTransformPreview(null);
  }

  function patchTable(tableIndex, patch) {
    markTransformDirty();
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      tableMappings[tableIndex] = { ...tableMappings[tableIndex], ...patch };
      return { ...curr, tableMappings };
    });
  }

  function patchColumn(tableIndex, colIndex, patch) {
    markTransformDirty();
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const tableMappings = [...(curr.tableMappings || [])];
      const table = { ...tableMappings[tableIndex] };
      const columnMappings = [...(table.columnMappings || [])];
      columnMappings[colIndex] = { ...columnMappings[colIndex], ...patch };
      table.columnMappings = columnMappings;
      tableMappings[tableIndex] = table;
      return { ...curr, tableMappings };
    });
  }

  function patchTransformConfig(tableIndex, colIndex, patch) {
    const table = currentProject?.tableMappings?.[tableIndex];
    const column = table?.columnMappings?.[colIndex] || {};
    patchColumn(tableIndex, colIndex, {
      transform: {
        ...(column.transform || { type: 'direct', config: {} }),
        config: { ...(column.transform?.config || {}), ...patch },
      },
    });
  }

  function setTransformType(tableIndex, colIndex, selected) {
    const table = currentProject?.tableMappings?.[tableIndex];
    const column = table?.columnMappings?.[colIndex] || {};
    if (selected.startsWith('preset:')) {
      const presetName = selected.slice('preset:'.length);
      const preset = transformCatalog.find((item) => item.name === presetName);
      patchColumn(tableIndex, colIndex, { transform: { preset: presetName, ...(preset?.rule || { type: 'direct', config: {} }) } });
      return;
    }
    patchColumn(tableIndex, colIndex, { transform: defaultTransformForType(selected, column) });
  }

  function patchRowFilter(tableIndex, patch) {
    const mapping = currentProject?.tableMappings?.[tableIndex] || {};
    patchTable(tableIndex, {
      rowFilter: {
        enabled: false,
        expression: '',
        config: { requiredColumns: [] },
        ...(mapping.rowFilter || {}),
        ...patch,
      },
    });
  }

  async function saveProject() {
    if (!currentProject?.id) return null;
    const dedupedTableMappings = dedupeTableMappings(currentProject.tableMappings || []);
    const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}`, {
      method: 'PUT',
      body: {
        name: currentProject.name,
        notes: currentProject.notes || '',
        sourceSchema: currentProject.sourceSchema || workspace.sourceSchema,
        targetSchema: currentProject.targetSchema || workspace.targetSchema,
        includeViews: currentProject.includeViews ?? workspace.includeViews,
        sourceCatalog: currentProject.sourceCatalog,
        targetCatalog: currentProject.targetCatalog,
        tableMappings: dedupedTableMappings,
      },
      timeoutMs: 120000,
    });
    const project = normalizeProjectForUi(resp.project || null);
    setCurrentProject(project);
    setMappingDirty(false);
    await refreshProjects().catch(() => []);
    return project;
  }

  async function saveTransforms() {
    await withBusy('save-transforms', async () => {
      await saveProject();
      setMessage('Saved project transform configuration');
    });
  }

  async function runTransformPreview() {
    if (!currentProject?.id) {
      setError('No active project. Create or load a project first.');
      return;
    }
    await withBusy('transform-preview', async () => {
      await saveProject();
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}/transform-preview`, {
        method: 'POST',
        body: {
          sourceConnection: workspace.sourceConnection,
          sampleLimit: Number(sampleLimit || 5),
          mode: 'all',
          selectedTables: [],
          loadPhase: 'configured',
        },
        timeoutMs: 120000,
      });
      setTransformPreview(resp.preview || null);
      const errors = resp.preview?.summary?.transformErrorCount || 0;
      setMessage(errors ? `Transform preview completed with ${errors} transform errors` : 'Transform preview passed');
    });
  }

  async function savePreviewAndContinue() {
    await runTransformPreview();
    setTab('validate-run');
  }

  function renderTransformConfig({ tableIndex, colIndex, mapping, column }) {
    const type = column.transform?.type || 'direct';
    const config = column.transform?.config || {};
    const sourceTable = tableByName(sourceCatalog, mapping.sourceTable);
    const sourceColumns = tableColumns(sourceTable);
    const lookupTable = tableByName(sourceCatalog, config.table);
    const lookupColumns = tableColumns(lookupTable);

    if (type === 'lookup') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <textarea
            value={formatValueMap(config.values || {})}
            onChange={(e) => patchTransformConfig(tableIndex, colIndex, { values: parseValueMap(e.target.value) })}
            placeholder={'1=Y\n0=N'}
            style={{ minHeight: 90 }}
          />
          <input value={config.defaultValue ?? ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { defaultValue: e.target.value })} placeholder="Default value when no map entry matches" />
        </div>
      );
    }

    if (type === 'lookup_table') {
      return (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field"><div className="field-label">Lookup table</div><select value={config.table || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { table: e.target.value, lookupColumn: '', valueColumn: '' })}><option value="">— select table —</option>{sourceTables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}</select></div>
          <div className="field"><div className="field-label">Local source column</div><select value={config.localColumn || column.sourceColumn || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { localColumn: e.target.value })}><option value="">— select local key —</option>{sourceColumns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></div>
          <div className="field"><div className="field-label">Lookup key column</div><select value={config.lookupColumn || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { lookupColumn: e.target.value })}><option value="">— select lookup key —</option>{lookupColumns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></div>
          <div className="field"><div className="field-label">Lookup value column</div><select value={config.valueColumn || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { valueColumn: e.target.value })}><option value="">— select value column —</option>{lookupColumns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></div>
          <div className="field"><div className="field-label">Missing key</div><select value={config.missing || 'reject'} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { missing: e.target.value })}><option value="reject">reject row</option><option value="null">write null</option><option value="default">use default</option></select></div>
          <div className="field"><div className="field-label">Default value</div><input value={config.defaultValue ?? ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { defaultValue: e.target.value })} disabled={(config.missing || 'reject') !== 'default'} /></div>
        </div>
      );
    }

    if (type === 'expression') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <input value={config.expression || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { expression: e.target.value })} placeholder="value === '1' ? 'Y' : 'N'" />
          <input value={commaList(config.requiredColumns)} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { requiredColumns: parseCommaList(e.target.value) })} placeholder="Required source columns, comma-separated" />
        </div>
      );
    }

    if (type === 'constant') {
      return <input style={{ marginTop: 8 }} value={config.value ?? ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { value: e.target.value })} placeholder="Constant target value" />;
    }

    if (type === 'template') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <input value={config.template || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { template: e.target.value })} placeholder="{{first_name}} {{last_name}}" />
          <input value={commaList(config.requiredColumns)} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { requiredColumns: parseCommaList(e.target.value) })} placeholder="Required source columns, comma-separated" />
        </div>
      );
    }

    if (type === 'concat' || type === 'coalesce') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <input value={commaList(config.fields)} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { fields: parseCommaList(e.target.value) })} placeholder="Source fields, comma-separated" />
          {type === 'concat' ? <input value={config.delimiter ?? ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { delimiter: e.target.value })} placeholder="Delimiter" /> : null}
        </div>
      );
    }

    if (type === 'conditional') {
      return (
        <textarea
          style={{ marginTop: 8, minHeight: 100 }}
          value={formatJson(config)}
          onChange={(e) => {
            const parsed = safeJsonParse(e.target.value);
            if (parsed) patchColumn(tableIndex, colIndex, { transform: { type: 'conditional', config: parsed } });
          }}
        />
      );
    }

    if (type === 'mojibake_repair') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div className="field">
            <div className="field-label">Mode</div>
            <select value={config.mode || 'auto'} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { mode: e.target.value })}>
              <option value="auto">auto — detect and repair</option>
              <option value="force">force — always repair</option>
              <option value="detect_only">detect only — flag but don't repair</option>
            </select>
          </div>
          <div className="hint">Detects and repairs Unicode mojibake encoding mismatches (Telugu, Sanskrit, IAST, UTF-8/Latin-1, Windows-1252)</div>
        </div>
      );
    }

    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Transform" hint="Configure row filters, value rewrites, expressions, and lookup-table enrichments before validation and load." action={<span className="badge">Step 3</span>} />
        <div className="toolbar" style={{ marginBottom: 14 }}>
          {mappingDirty ? <span className="badge" style={{ borderColor: '#d97706', color: '#d97706' }}>Unsaved transform changes</span> : <span className="badge">Transforms saved</span>}
          <div className="field" style={{ minWidth: 120 }}><div className="field-label">Sample rows</div><input type="number" min="1" max="50" value={sampleLimit} onChange={(e) => setSampleLimit(Number(e.target.value || 5))} /></div>
          <button className="btn" type="button" onClick={() => void saveTransforms()} disabled={!currentProject?.id || busy['save-transforms']}>{busy['save-transforms'] ? 'Saving…' : 'Save project transforms'}</button>
          <button className="btn" type="button" onClick={() => void runTransformPreview()} disabled={!currentProject?.id || busy['transform-preview']}>{busy['transform-preview'] ? 'Previewing…' : 'Preview all transforms'}</button>
          <button className="btn primary" type="button" onClick={() => void savePreviewAndContinue()} disabled={!currentProject?.id || busy['transform-preview']}>Preview all & continue</button>
        </div>

        {!currentProject ? <div className="hint">Create or load a project first.</div> : null}
        {currentProject && !enabledMappings.length ? <div className="alert warn"><div style={{ fontWeight: 800 }}>No enabled mappings</div><div className="hint" style={{ marginTop: 6 }}>Go to Mapping and add at least one enabled table mapping.</div></div> : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(currentProject?.tableMappings || []).map((mapping, tableIndex) => {
            const sourceTable = tableByName(sourceCatalog, mapping.sourceTable);
            const targetTable = tableByName(targetCatalog, mapping.targetTable);
            const sourceColumns = tableColumns(sourceTable);
            const tablePreview = (transformPreview?.tables || []).find((item) => item.sourceTable === mapping.sourceTable);
            return (
              <div key={mapping.id || `${mapping.sourceTable}:${tableIndex}`} className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <SectionTitle
                  title={`${mapping.sourceTable || 'source'} → ${mapping.targetTable || 'target'}`}
                  hint={mapping.enabled === false ? 'Disabled table mapping' : `Transform status: ${tablePreview?.status || 'not previewed'}`}
                  action={tablePreview ? <span className="badge">{tablePreview.status}</span> : <span className="badge">No preview</span>}
                />

                <div className="card" style={{ background: 'rgba(59,130,246,0.06)', marginBottom: 12 }}>
                  <SectionTitle title="Row filter" hint="Filter rows after extraction and before target writes." />
                  <div className="form-grid">
                    <label className="check"><input type="checkbox" checked={mapping.rowFilter?.enabled === true} onChange={(e) => patchRowFilter(tableIndex, { enabled: e.target.checked })} /><span className="field-label" style={{ margin: 0 }}>Enable row filter</span></label>
                    <div className="field full"><div className="field-label">Expression</div><input value={mapping.rowFilter?.expression || ''} onChange={(e) => patchRowFilter(tableIndex, { expression: e.target.value })} placeholder="row.status !== 'deleted'" disabled={mapping.rowFilter?.enabled !== true} /></div>
                    <div className="field full"><div className="field-label">Required columns</div><input value={commaList(mapping.rowFilter?.config?.requiredColumns)} onChange={(e) => patchRowFilter(tableIndex, { config: { ...(mapping.rowFilter?.config || {}), requiredColumns: parseCommaList(e.target.value) } })} placeholder="status, deleted_at" disabled={mapping.rowFilter?.enabled !== true} /></div>
                  </div>
                </div>

                <div className="schema-table-scroll" style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Target column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Source column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Transform</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Config</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mapping.columnMappings || []).filter((column) => column.enabled !== false && column.targetColumnMode !== 'ignore' && column.targetColumn).map((column) => {
                        const colIndex = (mapping.columnMappings || []).findIndex((item) => item.id === column.id);
                        const selectedType = column.transform?.preset ? `preset:${column.transform.preset}` : (column.transform?.type || 'direct');
                        const sourceColumn = columnByName(sourceTable, column.sourceColumn);
                        const targetColumn = columnByName(targetTable, column.targetColumn);
                        return (
                          <tr key={column.id}>
                            <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.targetColumn}<div className="hint">{describeColumn(targetColumn) || '—'}</div></td>
                            <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.sourceColumn}<div className="hint">{describeColumn(sourceColumn) || '—'}</div></td>
                            <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)', minWidth: 180 }}>
                              <select value={selectedType} onChange={(e) => setTransformType(tableIndex, colIndex, e.target.value)}>
                                {transformTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                                {transformCatalog.map((item) => <option key={item.name} value={`preset:${item.name}`}>preset:{item.name}</option>)}
                              </select>
                              <input style={{ marginTop: 8 }} value={column.transform?.config?.when || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, { when: e.target.value })} placeholder="Optional condition" />
                            </td>
                            <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)', minWidth: 360 }}>{renderTransformConfig({ tableIndex, colIndex, mapping, column })}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {tablePreview ? (
                  <details style={{ marginTop: 12 }} open>
                    <summary className="btn" style={{ display: 'inline-flex' }}>Preview</summary>
                    <div className="toolbar" style={{ marginTop: 12, marginBottom: 8 }}>
                      <span className="badge">Required columns: {(tablePreview.requiredColumns || []).join(', ') || 'default'}</span>
                      <span className="badge">Filtered: {tablePreview.filteredRowCount || 0}</span>
                      <span className="badge">Errors: {(tablePreview.transformErrors || []).length}</span>
                    </div>
                    {tablePreview.lookupDependencies?.length ? <div className="hint" style={{ marginBottom: 8 }}>Lookup joins: {tablePreview.lookupDependencies.map((item) => `${item.localColumn} → ${item.table}.${item.lookupColumn}.${item.valueColumn}`).join(' • ')}</div> : null}
                    {tablePreview.transformErrors?.length ? <div className="alert warn"><div style={{ fontWeight: 800 }}>Transform errors</div><div className="hint" style={{ marginTop: 6 }}>{tablePreview.transformErrors.map((item) => item.message).join(' • ')}</div></div> : null}
                    <div className="grid" style={{ alignItems: 'start' }}>
                      <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>{formatJson({ sampleRows: tablePreview.sampleRows || [] })}</div>
                      <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>{formatJson({ transformedRows: tablePreview.transformedRows || [] })}</div>
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <SectionTitle title="Transform preview summary" hint="Saved preview fingerprint used by execution gating." />
        {transformPreview ? (
          <div className="toolbar" style={{ marginBottom: 12 }}>
            <span className="badge">Fingerprint: {transformPreview.transformFingerprint}</span>
            <span className="badge">Tables: {transformPreview.summary?.tableCount || 0}</span>
            <span className="badge">Ready: {transformPreview.summary?.readyCount || 0}</span>
            <span className="badge">Errors: {transformPreview.summary?.transformErrorCount || 0}</span>
          </div>
        ) : null}
        <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{transformPreview ? formatJson(transformPreview) : '—'}</div>
      </div>
    </div>
  );
}

function ValidateRunScreen() {
  const { workspace, currentProject, setCurrentProject, currentRun, preflightReport, setPreflightReport, transformPreview, setTransformPreview, dryRunPreview, setDryRunPreview, runReport, setRunReport, cutoverReport, setCutoverReport, selectedProjectId, selectedRunId, setSelectedRunId, runs, loadRun, loadRunReport, refreshProjects, refreshRuns, streamRun, logs, setLogs, withBusy, busy, setMessage, setError, mappingDirty, setMappingDirty } = useApp();
  const [runErrors, setRunErrors] = useState([]);
  const [replayPlan, setReplayPlan] = useState(null);
  const [replayImportJson, setReplayImportJson] = useState('');
  const [replays, setReplays] = useState([]);
  const [verification, setVerification] = useState(null);
  const [verificationIssueView, setVerificationIssueView] = useState({ view: 'open', table: '' });
  const [verifiedExecutionSignature, setVerifiedExecutionSignature] = useState('');
  const [watermarks, setWatermarks] = useState(null);
  const issuePanelRef = useRef(null);
  const [executeOptions, setExecuteOptions] = useState({ mode: 'all', selectedTables: [], dryRun: false, errorPolicy: 'fail-fast', concurrency: 1, batchSize: 1000, cdcMode: 'off', loadPhase: 'configured', cutoverMode: 'manual', watermarkColumn: '', verificationFingerprint: '', transformFingerprint: '' });
  const watermarkInvalid = executeOptions.cdcMode === 'watermark' && !String(executeOptions.watermarkColumn || '').trim();
  const selectedTableList = Array.isArray(executeOptions.selectedTables)
    ? executeOptions.selectedTables
    : String(executeOptions.selectedTables || '').split(',').map((s) => s.trim()).filter(Boolean);
  const selectedModeMissingTables = executeOptions.mode === 'selected' && selectedTableList.length === 0;
  const enabledTableOptions = (currentProject?.tableMappings || [])
    .filter((mapping) => mapping.enabled !== false && mapping.sourceTable)
    .map((mapping) => ({ sourceTable: mapping.sourceTable, targetTable: mapping.targetTable || '—' }));
  const enabledUiMappings = (currentProject?.tableMappings || []).filter((mapping) => mapping.enabled !== false && mapping.sourceTable);
  const hasEnabledMappings = enabledUiMappings.length > 0;
  const transformErrorCount = transformPreview?.summary?.transformErrorCount || 0;
  const transformScopeCurrent = transformPreviewCoversRun(transformPreview, executeOptions, selectedTableList);
  const transformReady = Boolean(transformPreview?.transformFingerprint) && transformScopeCurrent && !transformErrorCount;
  function showVerificationIssues(nextView = {}) {
    setVerificationIssueView((curr) => ({ ...curr, ...nextView }));
    setTimeout(() => {
      try {
        issuePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch {
        // ignore scroll failures
      }
    }, 0);
  }
  function describeSchemaAction(action) {
    if (action === 'create_table') return 'Target table will be created before loading.';
    if (action === 'alter_table_add_columns') return 'Missing target columns need to be added before loading.';
    if (action === 'missing_target_table') return 'Target table does not exist. Select an existing target table or mark the mapping to create a new target table.';
    if (action === 'target_name_conflict') return 'Target table already exists but the mapping is marked create-new. Choose the existing target table or pick a different new table name.';
    if (action === 'manual_fix_required') return 'Target schema has incompatible columns. Adjust the mapping or change the target schema before loading.';
    if (action === 'use_existing') return 'Existing target table can be used.';
    return action ? `Schema action: ${action}` : 'No schema action.';
  }

  function formatIssueKind(kind) {
    return String(kind || 'issue').replace(/_/g, ' ');
  }

  function formatKnownReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return '';
    const known = {
      target_text_is_value_safe_but_not_strict_round_trip_varchar: 'varchar/text mapping is value-safe, but it is not an exact round-trip type match.',
      target_integer_type_is_wider_than_source_mapping: 'target integer type is wider than the source mapping.',
      target_float_type_is_wider_than_source_mapping: 'target floating-point type is wider than the source mapping.',
      char_trailing_space_semantics_review: 'CHAR trailing-space behavior can differ between engines.',
      postgres_json_preserves_text_more_than_jsonb_but_indexing_differs: 'PostgreSQL JSON preserves source text differently than JSONB and has different indexing behavior.',
      datetime_to_timestamptz_changes_timezone_semantics: 'datetime to timestamptz changes timezone semantics.',
      timestamp_instant_loaded_into_timezone_neutral_column: 'timestamp with timezone is being loaded into a timezone-neutral column.',
    };
    return known[text] || text.replace(/_/g, ' ');
  }

  function formatCompatibilityReviewMessage(message) {
    const text = String(message || '').trim().replace(/^(conditional|review|risky|compatible):\s*/i, '');
    if (!text) return 'review the source and target column compatibility before loading.';
    return text.split(/\s*•\s*/).map(formatKnownReason).filter(Boolean).join(' ');
  }

  function formatCompatibilityDetail(issue = {}) {
    const comparison = issue.comparison || {};
    const rawMessage = String(issue.message || '').trim();
    const match = rawMessage.match(/^source\s+(.+?)\s*->\s*target\s+(.+)$/i);
    const sourceType = comparison.proposedType || match?.[1] || '';
    const targetType = comparison.targetType || match?.[2] || '';
    if (!sourceType && !targetType) return '';
    return `${sourceType || 'source type'} to ${targetType || 'target type'}`;
  }

  function formatReadinessReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return '';
    let match = text.match(/^Review\s+([^:]+):\s*(.+)$/i);
    if (match) return `Column "${match[1]}" needs review: ${formatCompatibilityReviewMessage(match[2])}`;
    match = text.match(/^Default differs for column\s+(.+)$/i);
    if (match) return `Column "${match[1]}" has a different target default. Verify it matches your migration intent.`;
    match = text.match(/^Required target column\s+(.+?)\s+is not mapped$/i);
    if (match) return `Target column "${match[1]}" is required but no source column is mapped to it.`;
    match = text.match(/^Backfill\/re-apply NOT NULL manually for\s+(.+)$/i);
    if (match) return `Column "${match[1]}" needs a backfill before re-applying NOT NULL.`;
    match = text.match(/^Incompatible target column\s+([^:]+):\s*(.+)$/i);
    if (match) return `Target column "${match[1]}" is incompatible: ${formatKnownReason(match[2])}`;
    return formatKnownReason(text);
  }

  function describeVerificationIssue(issue = {}, fallbackTable = {}) {
    const rawMessage = String(issue.message || '').trim();
    const tableName = issue.table || fallbackTable.sourceTable || '';
    const targetName = issue.target || fallbackTable.targetTable || '';
    const sourceColumn = issue.sourceColumn || issue.column || '';
    const targetColumn = issue.targetColumn || issue.column || '';
    const comparison = issue.comparison || {};
    const compatibilityDetail = formatCompatibilityDetail(issue);
    switch (issue.kind) {
      case 'no_enabled_table_mappings':
        return 'At least one enabled table mapping is required before verification or execution.';
      case 'duplicate_source_table_mapping':
        return `Source table "${tableName || issue.target || 'unknown'}" is mapped more than once. Keep one mapping or disable the duplicate.`;
      case 'duplicate_source_column_mapping':
        return `Source column "${sourceColumn || 'unknown'}" is mapped more than once for this table.`;
      case 'duplicate_target_column_mapping':
        return `Target column "${targetColumn || 'unknown'}" receives values from more than one source column.`;
      case 'missing_source_table':
        return `Source table "${tableName || 'unknown'}" was not found in the saved source catalog.`;
      case 'missing_target_table':
        return `Target table "${targetName || 'unknown'}" does not exist. Select an existing target table or create/provision one.`;
      case 'missing_new_target_table_name':
        return 'This mapping is set to create a new target table, but no target table name is provided.';
      case 'missing_conflict_keys':
        return 'Upsert mode needs conflict keys that match a target primary key or unique constraint.';
      case 'invalid_conflict_keys':
        return `Configured conflict keys (${(issue.conflictKeys || []).join(', ') || 'none'}) do not match a target primary key or unique constraint.`;
      case 'missing_watermark_column':
        return `Watermark column "${issue.watermarkColumn || 'unknown'}" does not exist on the source table.`;
      case 'no_enabled_column_mappings':
        return 'At least one enabled source column must map to a target column.';
      case 'missing_target_column_mapping':
        return `Source column "${sourceColumn || 'unknown'}" is enabled but has no target column. Map it or mark it ignored.`;
      case 'missing_new_target_column_name':
        return `Source column "${sourceColumn || 'unknown'}" is set to create a new target column, but no new column name is provided.`;
      case 'missing_source_column':
        return `Source column "${sourceColumn || 'unknown'}" was not found in the saved source catalog.`;
      case 'missing_target_column':
        return `Target column "${targetColumn || 'unknown'}" was not found in the saved target catalog.`;
      case 'unsupported_transform':
        return `Transform "${issue.transform || 'unknown'}" is not supported for ${sourceColumn || 'this column'}.`;
      case 'target_not_null_source_nullable':
        if (issue.nullCountKnown && Number(issue.nullCount || 0) > 0) {
          return `Target column "${targetColumn || 'unknown'}" is NOT NULL, but source column "${sourceColumn || 'unknown'}" has ${issue.nullCount} NULL ${Number(issue.nullCount) === 1 ? 'row' : 'rows'}. Add a transform/default/filter, make the target nullable, or fix the data.`;
        }
        if (issue.nullCountKnown) {
          return `Target column "${targetColumn || 'unknown'}" is NOT NULL and source column "${sourceColumn || 'unknown'}" is nullable in schema, but an exact scan found 0 NULL rows.`;
        }
        return `Target column "${targetColumn || 'unknown'}" is NOT NULL and source column "${sourceColumn || 'unknown'}" is nullable in schema. Exact NULL count could not be computed, so this requires explicit approval or a schema/mapping fix.`;
      case 'type_not_safely_assignable':
        return `Target column "${targetColumn || 'unknown'}" cannot safely store values from source column "${sourceColumn || 'unknown'}"${compatibilityDetail ? ` (${compatibilityDetail})` : ''}. Change the target type, choose a different target column, or add a transform.`;
      case 'compatibility_review_required':
        return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}" and needs compatibility review before loading.`;
      case 'incompatible_type':
        if (comparison.nullableCompatible === false) {
          return `Target column "${targetColumn || 'unknown'}" is NOT NULL but source column "${sourceColumn || 'unknown'}" can contain NULL values. Make the target nullable, add a default/backfill, or transform/filter NULL values before loading.`;
        }
        if (comparison.compatibleType === false) {
          return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}", but the target type cannot safely store the mapped source values${compatibilityDetail ? ` (${compatibilityDetail})` : ''}. Change the target type, choose a different target column, or add a transform.`;
        }
        return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}" and needs compatibility review${compatibilityDetail ? ` (${compatibilityDetail})` : ''}. Adjust the mapping or target schema before loading.`;
      case 'unmapped_required_target_column':
        return `Target column "${targetColumn || 'unknown'}" is required but no source column is mapped to it. Map a source column, add a default, or make it nullable.`;
      case 'append_mode_duplicate_risk':
        return 'Append mode can duplicate rows on retry/resume unless target uniqueness prevents it.';
      case 'truncate_mode_restart_recommended':
        return 'Truncate mode is safest when rerun from the start after interruption.';
      case 'watermark_without_primary_key':
        return 'Watermark mode works best with a stable primary-key tie-breaker.';
      case 'risky_cast':
        return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}" and needs review: ${formatCompatibilityReviewMessage(rawMessage)}`;
      case 'transform_required':
        return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}" and needs a transform before loading: ${formatCompatibilityReviewMessage(rawMessage)}`;
      case 'target_column_will_be_created':
        return `Target column "${targetColumn || sourceColumn || 'unknown'}" will be created before loading.`;
      case 'target_table_will_be_created':
        return `Target table "${targetName || tableName || 'unknown'}" will be created before loading.`;
      case 'unexpected_boolean_values':
        return `Boolean-like source column "${sourceColumn || 'unknown'}" has unexpected sample values: ${(issue.samples || []).join(', ') || 'unknown'}.`;
      case 'transform_runtime_warning':
        return `A transform/filter preview raised a warning for table "${tableName || 'unknown'}".`;
      case 'table_mapping_disabled':
        return `Table mapping "${tableName || 'unknown'}" is disabled and will not run.`;
      case 'incompatible_target_column':
        if (comparison.nullableCompatible === false || /NOT NULL/i.test(rawMessage)) {
          return `Target column "${targetColumn || 'unknown'}" is NOT NULL but source column "${sourceColumn || 'unknown'}" can contain NULL values. Make the target nullable, add a default/backfill, or transform/filter NULL values before loading.`;
        }
        if (comparison.compatibleType === false) {
          return `Target column "${targetColumn || 'unknown'}" cannot safely store source column "${sourceColumn || 'unknown'}"${compatibilityDetail ? ` (${compatibilityDetail})` : ''}.`;
        }
        return rawMessage ? formatReadinessReason(rawMessage) : `Target column "${targetColumn || 'unknown'}" is incompatible with the mapped source column.`;
      case 'missing_historical_filter':
        return 'Historical filtered load requires a filter column, operator, and value.';
      case 'invalid_historical_filter_column':
        return `Historical filter column "${issue.column || 'unknown'}" was not found on source table "${tableName || 'unknown'}".`;
      case 'missing_historical_filter_value':
        return `Historical filter column "${issue.column || 'unknown'}" needs a filter value.`;
      case 'missing_historical_filter_end_value':
        return `Historical between-filter column "${issue.column || 'unknown'}" needs an end value.`;
      case 'historical_filter_review':
        return 'Review filtered historical loads carefully before execution.';
      case 'missing_incremental_watermark_column':
        return `Incremental load requires a valid source watermark column on table "${tableName || 'unknown'}".`;
      case 'missing_incremental_tie_breaker_column':
        return `Incremental load requires a stable tie-breaker column, preferably a primary key, on table "${tableName || 'unknown'}".`;
      case 'nullable_watermark_column':
        return `Watermark column "${issue.watermarkColumn || 'unknown'}" is nullable, which can cause missed or unstable incremental reads.`;
      case 'incremental_without_upsert':
        return 'Incremental loads that may update existing rows are safest with write mode upsert and valid conflict keys.';
      case 'incremental_without_conflict_keys':
        return 'Without conflict keys, incremental replays or lookback windows can duplicate rows.';
      case 'no_incremental_lookback_window':
        return 'A small lookback window helps catch late-arriving updates.';
      case 'incremental_hard_deletes_not_captured':
        return 'Watermark incremental loads do not capture hard deletes. Use a soft-delete column or manual reconciliation.';
      case 'missing_soft_delete_column':
        return `Soft-delete column "${issue.column || 'unknown'}" was not found on the source table.`;
      default:
        if (/^source\s+.+\s*->\s*target\s+.+$/i.test(rawMessage) && (sourceColumn || targetColumn)) {
          return `Column "${sourceColumn || 'unknown'}" maps to "${targetColumn || 'unknown'}" and needs compatibility review${compatibilityDetail ? ` (${compatibilityDetail})` : ''}.`;
        }
        return rawMessage ? formatReadinessReason(rawMessage) : (issue.kind ? `Review issue: ${formatIssueKind(issue.kind)}` : String(issue));
    }
  }

  function createVerificationIssueItem(severity, issue = {}, fallbackTable = {}, scope = 'Table') {
    const sourceTable = issue.sourceTable || fallbackTable.sourceTable || issue.table || '';
    const targetTable = fallbackTable.targetTable || issue.targetTable || (issue.target && issue.target !== 'project' ? issue.target : '');
    const sourceColumn = issue.sourceColumn || '';
    const targetColumn = issue.targetColumn || issue.column || '';
    const prefix = severity === 'blocker' ? 'Blocker' : 'Warning';
    const columnTitle = sourceColumn || targetColumn ? `${sourceColumn || 'source column'} → ${targetColumn || 'target column'}` : '';
    const tableTitle = sourceTable || targetTable ? [sourceTable, targetTable].filter(Boolean).join(' → ') : '';
    return {
      severity,
      scope,
      sourceTable,
      targetTable,
      sourceColumn,
      targetColumn,
      kind: issue.kind || severity,
      title: `${prefix}: ${columnTitle || tableTitle || formatIssueKind(issue.kind || severity)}`,
      message: describeVerificationIssue(issue, { ...fallbackTable, sourceTable, targetTable }),
      raw: issue,
    };
  }

  function collectVerificationIssues(nextVerification = verification) {
    const items = [];
    const projectIssueKinds = new Set(['no_enabled_table_mappings', 'duplicate_source_table_mapping']);
    for (const issue of nextVerification?.report?.blockers || []) {
      if (!projectIssueKinds.has(issue.kind) && issue.target !== 'project') continue;
      items.push(createVerificationIssueItem('blocker', issue, {}, 'Project'));
    }
    for (const issue of nextVerification?.report?.warnings || []) {
      if (!projectIssueKinds.has(issue.kind) && issue.target !== 'project') continue;
      items.push(createVerificationIssueItem('warning', issue, {}, 'Project'));
    }
    for (const table of nextVerification?.report?.tables || []) {
      for (const issue of table.blockers || []) {
        items.push(createVerificationIssueItem('blocker', issue, table, table.sourceTable || table.targetTable || 'Table'));
      }
      for (const issue of table.warnings || []) {
        items.push(createVerificationIssueItem('warning', issue, table, table.sourceTable || table.targetTable || 'Table'));
      }
    }
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.severity}:${item.sourceTable}:${item.targetTable}:${item.sourceColumn}:${item.targetColumn}:${item.kind}:${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeServerIssueForUi(issue = {}) {
    const sourceColumn = issue.sourceColumn || '';
    const targetColumn = issue.targetColumn || '';
    const sourceTable = issue.sourceTable || '';
    const targetTable = issue.targetTable || '';
    const prefix = issue.severity === 'blocker' ? (issue.status === 'allowed' ? 'Allowed blocker' : 'Open blocker') : 'Warning';
    const columnTitle = sourceColumn || targetColumn ? `${sourceColumn || 'source column'} → ${targetColumn || 'target column'}` : '';
    const tableTitle = sourceTable || targetTable ? [sourceTable, targetTable].filter(Boolean).join(' → ') : '';
    return {
      ...issue,
      scope: issue.scope || tableTitle || 'Project',
      title: `${prefix}: ${columnTitle || tableTitle || formatIssueKind(issue.kind || issue.severity)}`,
      message: issue.message || describeVerificationIssue(issue, { sourceTable, targetTable }),
      status: issue.status || (issue.severity === 'warning' ? 'warning' : 'open'),
    };
  }

  const verificationIssues = useMemo(() => {
    if (Array.isArray(verification?.issues) && verification.issues.length) {
      return verification.issues.map(normalizeServerIssueForUi);
    }
    return collectVerificationIssues(verification);
  }, [verification]);
  const openVerificationBlockers = verificationIssues.filter((item) => item.severity === 'blocker' && item.status !== 'allowed');
  const warningVerificationIssues = verificationIssues.filter((item) => item.severity === 'warning');
  const topGateIssues = openVerificationBlockers.length ? openVerificationBlockers : warningVerificationIssues;
  const filteredVerificationIssues = verificationIssues.filter((item) => {
    if (verificationIssueView.view === 'open' && !(item.severity === 'blocker' && item.status !== 'allowed')) return false;
    if (verificationIssueView.view === 'allowed' && !(item.severity === 'blocker' && item.status === 'allowed')) return false;
    if (verificationIssueView.view === 'warning' && item.severity !== 'warning') return false;
    if (verificationIssueView.table && item.sourceTable !== verificationIssueView.table && item.targetTable !== verificationIssueView.table) return false;
    return true;
  });
  const primaryGateIssue = openVerificationBlockers[0] || verificationIssues[0] || null;
  const verificationStale = mappingDirty && Boolean(verification);
  const currentExecutionSignature = buildExecutionOptionsSignature(executeOptions, selectedTableList);
  const executionOptionsStale = Boolean(verification) && verifiedExecutionSignature !== currentExecutionSignature;
  const canExecute = Boolean(verification?.readyToLoad) && transformReady && !watermarkInvalid && !selectedModeMissingTables && !mappingDirty && !executionOptionsStale && hasEnabledMappings;

  function readinessBadge(level) {
    if (level === 'ready') return 'Ready';
    if (level === 'review') return 'Review';
    if (level === 'provision') return 'Provision';
    if (level === 'blocked') return 'Blocked';
    return 'Unknown';
  }

  function readinessNextStep(item = {}) {
    const openCount = item.openBlockerCount ?? item.blockerCount ?? 0;
    if (openCount > 0) return 'Fix open blockers';
    if ((item.allowedBlockerCount || 0) > 0) return 'Allowed by intent';
    if ((item.warningCount || 0) > 0) return 'Review warnings';
    if (item.schemaAction === 'create_table' || item.schemaAction === 'alter_table_add_columns') return 'Provision target';
    if (item.schemaAction === 'manual_fix_required') return 'Review schema';
    if (item.readiness?.level === 'ready') return 'Ready to load';
    return 'Review details';
  }

  function executionGateMessage() {
    if (!hasEnabledMappings) return `No enabled table mappings exist in the current UI state. Go to Mapping and add at least one manual source → target table mapping. Current mappings: ${(currentProject?.tableMappings || []).length}.`;
    if (mappingDirty) return 'You have unsaved mapping changes. Click Save mappings in Mapping, then run Verify project.';
    if (verificationStale) return 'Mappings changed after verification. Save and verify again.';
    if (!transformPreview?.transformFingerprint) return 'Run Transform preview first.';
    if (transformErrorCount) return 'Resolve Transform preview errors before execution.';
    if (!transformScopeCurrent) return 'Transform preview does not match the current run mode, selected tables, or load phase. Build dry run or rerun Transform preview.';
    if (executionOptionsStale) return 'Execution options changed after verification. Run Verify project again.';
    if (watermarkInvalid) return 'Watermark mode requires a watermark column.';
    if (selectedModeMissingTables) return 'Selected mode requires at least one table selection.';
    if (!verification) return 'Run Verify project first. Verification will save current mappings before checking.';
    return primaryGateIssue?.message || 'Resolve verification blockers before loading data.';
  }

  async function runPreflight() {
    if (!selectedProjectId) return;
    await withBusy('preflight', async () => {
      if (!ensureReadyForValidation()) return;
      await saveMappingsIfNeeded();
      await performPreflight();
      setMessage('Preflight analysis completed');
    });
  }

  async function runDryRun() {
    if (!selectedProjectId) return;
    await withBusy('dry-run', async () => {
      if (!ensureReadyForValidation()) return;
      await saveMappingsIfNeeded();
      const nextTransformPreview = await performTransformPreview();
      if ((nextTransformPreview?.summary?.transformErrorCount || 0) > 0) {
        setDryRunPreview(null);
        setError('Dry run stopped: Transform preview found errors. Review the Transform tab first.');
        return;
      }
      const nextVerification = await performVerification();
      if (!nextVerification?.readyToLoad) {
        setDryRunPreview(null);
        setMessage('Dry run stopped: Verify project found blockers or pending schema actions. Review the Verification panel first.');
        return;
      }
      const nextPreflight = await performPreflight();
      if ((nextPreflight?.summary?.blockerCount || 0) > 0) {
        setDryRunPreview(null);
        setError('Dry run stopped: Preflight found blockers. Review the Preflight report before building a dry run.');
        return;
      }
      await performDryRunPreview();
      setMessage('Verify project and Preflight passed; dry run preview generated');
    });
  }

  async function verifyProject() {
    if (!selectedProjectId) return;
    await withBusy('verify', async () => {
      if (!ensureReadyForValidation()) return;
      await saveMappingsIfNeeded();
      const nextVerification = await performVerification();
      setMessage(nextVerification?.readyToLoad ? 'Verification passed — ready to load' : 'Verification completed with issues to review');
    });
  }

  async function performVerification() {
    const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/verify`, {
      method: 'POST',
      body: {
        ...buildRuntimeOverrides(workspace, { includeTarget: false }),
        mode: executeOptions.mode,
        selectedTables: executeOptions.mode === 'selected' ? selectedTableList : [],
        dryRun: executeOptions.dryRun,
        errorPolicy: executeOptions.errorPolicy,
        concurrency: Number(executeOptions.concurrency || 1),
        batchSize: Number(executeOptions.batchSize || 1000),
        cdcMode: executeOptions.cdcMode,
        loadPhase: executeOptions.loadPhase,
        cutoverMode: executeOptions.cutoverMode,
        watermarkColumn: executeOptions.watermarkColumn || undefined,
      },
      timeoutMs: 120000,
    });
    const nextVerification = resp.verification || null;
    setVerification(nextVerification);
    setVerifiedExecutionSignature(buildExecutionOptionsSignature(executeOptions, selectedTableList));
    setExecuteOptions((curr) => ({ ...curr, verificationFingerprint: nextVerification?.verificationFingerprint || '' }));
    await loadWatermarks(selectedProjectId).catch(() => null);
    return nextVerification;
  }

  async function performTransformPreview() {
    const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/transform-preview`, {
      method: 'POST',
      body: {
        ...buildRuntimeOverrides(workspace, { includeTarget: false }),
        mode: executeOptions.mode,
        selectedTables: executeOptions.mode === 'selected' ? selectedTableList : [],
        sampleLimit: 5,
        loadPhase: executeOptions.loadPhase,
      },
      timeoutMs: 120000,
    });
    const nextPreview = resp.preview || null;
    setTransformPreview(nextPreview);
    setExecuteOptions((curr) => ({ ...curr, transformFingerprint: nextPreview?.transformFingerprint || '' }));
    return nextPreview;
  }

  async function saveVerificationAllowances(nextAllowedIssues) {
    if (!selectedProjectId) return null;
    const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/verification-allowances`, {
      method: 'PUT',
      body: { allowedVerificationIssues: nextAllowedIssues },
      timeoutMs: 120000,
    });
    const project = normalizeProjectForUi(resp.project || null);
    setCurrentProject(project);
    await refreshProjects().catch(() => []);
    return project;
  }

  async function allowVerificationIssue(issue) {
    if (!issue?.issueKey || !issue.allowable) return;
    const reason = typeof window !== 'undefined' ? window.prompt(`Why is this blocker acceptable?\n\n${issue.message || issue.title || issue.kind}`, '') : '';
    if (!String(reason || '').trim()) {
      setError('A reason is required before allowing a blocker.');
      return;
    }
    await withBusy('verification-allowances', async () => {
      const existing = (currentProject?.allowedVerificationIssues || []).filter((item) => item.issueKey !== issue.issueKey);
      await saveVerificationAllowances([
        ...existing,
        {
          issueKey: issue.issueKey,
          kind: issue.kind,
          sourceTable: issue.sourceTable || '',
          targetTable: issue.targetTable || '',
          sourceColumn: issue.sourceColumn || '',
          targetColumn: issue.targetColumn || '',
          reason: String(reason).trim(),
          allowedAt: nowIso(),
        },
      ]);
      await performVerification();
      showVerificationIssues({ view: 'allowed', table: issue.sourceTable || issue.targetTable || '' });
      setMessage('Allowed blocker saved with your reason.');
    });
  }

  async function revokeVerificationIssue(issue) {
    if (!issue?.issueKey) return;
    await withBusy('verification-allowances', async () => {
      const existing = (currentProject?.allowedVerificationIssues || []).filter((item) => item.issueKey !== issue.issueKey);
      await saveVerificationAllowances(existing);
      await performVerification();
      showVerificationIssues({ view: 'open', table: issue.sourceTable || issue.targetTable || '' });
      setMessage('Allowed blocker revoked.');
    });
  }

  async function performPreflight() {
    const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/preflight`, { method: 'POST', body: buildRuntimeOverrides(workspace, { includeTarget: false }), timeoutMs: 120000 });
    const nextReport = resp.report || null;
    setPreflightReport(nextReport);
    return nextReport;
  }

  async function performDryRunPreview() {
    const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/dry-run`, { method: 'POST', body: { ...buildRuntimeOverrides(workspace, { includeTarget: false }), loadPhase: executeOptions.loadPhase }, timeoutMs: 120000 });
    const nextPreview = resp.preview ? { ...resp.preview, sqlText: buildDryRunSqlText(resp.preview) } : null;
    setDryRunPreview(nextPreview);
    return nextPreview;
  }

  function downloadDryRunSql() {
    if (!dryRunPreview?.sqlText) return;
    downloadText(`${selectedProjectId || 'project'}.dry-run.sql`, dryRunPreview.sqlText, 'text/sql');
  }

  function ensureReadyForValidation() {
    if (!currentProject?.id) {
      setError('No active project. Go to Workspace, introspect schemas, then continue to Mapping.');
      return false;
    }
    if (!hasEnabledMappings) {
      setError('No enabled manual table mappings exist. Go to Mapping, add at least one source → target table mapping, then save mappings.');
      setVerification(null);
      setPreflightReport(null);
      setDryRunPreview(null);
      return false;
    }
    return true;
  }

  async function saveMappingsIfNeeded() {
    if (!mappingDirty || !currentProject?.id) return currentProject;
    const dedupedTableMappings = dedupeTableMappings(currentProject.tableMappings || []);
    const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}`, {
      method: 'PUT',
      body: {
        name: currentProject.name,
        notes: currentProject.notes || '',
        sourceSchema: currentProject.sourceSchema || workspace.sourceSchema,
        targetSchema: currentProject.targetSchema || workspace.targetSchema,
        includeViews: currentProject.includeViews ?? workspace.includeViews,
        sourceCatalog: currentProject.sourceCatalog,
        targetCatalog: currentProject.targetCatalog,
        tableMappings: dedupedTableMappings,
      },
      timeoutMs: 120000,
    });
    const project = normalizeProjectForUi(resp.project || null);
    setCurrentProject(project);
    setMappingDirty(false);
    await refreshProjects().catch(() => []);
    setMessage('Saved mapping changes before validation.');
    return project;
  }

  async function loadWatermarks(projectId = selectedProjectId) {
    if (!projectId) return null;
    const resp = await api(`/projects/${encodeURIComponent(projectId)}/watermarks`, { timeoutMs: 120000 });
    setWatermarks(resp.watermarks || null);
    return resp.watermarks || null;
  }

  async function resetWatermark(tableName) {
    if (!selectedProjectId || !tableName) return;
    await withBusy(`reset-watermark-${tableName}`, async () => {
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/watermarks/${encodeURIComponent(tableName)}`, { method: 'DELETE', timeoutMs: 120000 });
      setWatermarks(resp.watermarks || null);
      setMessage(`Reset watermark for ${tableName}`);
    });
  }

  async function setWatermarkBaseline(tableName) {
    if (!selectedProjectId || !tableName || typeof window === 'undefined') return;
    const mapping = (currentProject?.tableMappings || []).find((item) => item.sourceTable === tableName);
    const strategy = mapping?.loadStrategy || {};
    const current = watermarks?.tables?.[tableName] || {};
    const lastWatermark = window.prompt(`Baseline watermark for ${tableName}`, current.lastWatermark ?? strategy.baselineWatermark ?? '');
    if (lastWatermark == null) return;
    const lastTieBreaker = window.prompt(`Baseline tie-breaker for ${tableName} (optional)`, current.lastTieBreaker ?? strategy.baselineTieBreaker ?? '');
    const body = {
      watermarkColumn: strategy.watermarkColumn || mapping?.watermarkColumn || current.watermarkColumn || '',
      tieBreakerColumn: strategy.tieBreakerColumn || current.tieBreakerColumn || '',
      lastWatermark: lastWatermark || null,
      lastTieBreaker: lastTieBreaker || null,
    };
    await withBusy(`set-watermark-${tableName}`, async () => {
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/watermarks/${encodeURIComponent(tableName)}`, { method: 'PUT', body, timeoutMs: 120000 });
      setWatermarks(resp.watermarks || null);
      setMessage(`Set watermark baseline for ${tableName}`);
    });
  }

  async function loadCutoverReadiness(runId) {
    if (!runId) return;
    const resp = await api(`/runs/${encodeURIComponent(runId)}/cutover-readiness`, {
      method: 'POST',
      body: buildRuntimeOverrides(workspace),
      timeoutMs: 120000,
    });
    setCutoverReport(resp.cutover || null);
  }

  function verificationSummary() {
    const report = verification?.report;
    if (!report) return null;
    const openBlockerCount = verification.openBlockerCount ?? report.summary?.openBlockerCount ?? report.summary?.blockerCount ?? 0;
    const allowedBlockerCount = verification.allowedBlockerCount ?? report.summary?.allowedBlockerCount ?? 0;
    const nonAllowableBlockerCount = verification.nonAllowableBlockerCount ?? report.summary?.nonAllowableBlockerCount ?? 0;
    const warningCount = verification.warningCount ?? report.summary?.warningCount ?? 0;
    return {
      blockerCount: openBlockerCount,
      openBlockerCount,
      allowedBlockerCount,
      nonAllowableBlockerCount,
      warningCount,
      readiness: verification.readyToLoad ? 'verified' : (openBlockerCount ? 'needs_manual_review' : 'verified_with_warnings'),
    };
  }

  const verificationMeta = verificationSummary();
  const sourceCatalog = resolveCatalog(currentProject?.sourceCatalog, null);
  const targetCatalog = resolveCatalog(currentProject?.targetCatalog, null);

  useEffect(() => {
    setCutoverReport(null);
  }, [selectedProjectId, verification?.verificationFingerprint, mappingDirty]);

  useEffect(() => {
    setExecuteOptions((curr) => ({ ...curr, transformFingerprint: transformPreview?.transformFingerprint || '' }));
  }, [transformPreview?.transformFingerprint]);

  useEffect(() => {
    setVerification(null);
    setVerifiedExecutionSignature('');
    setPreflightReport(null);
    setTransformPreview(null);
    setDryRunPreview(null);
    setRunReport(null);
    setCutoverReport(null);
    setRunErrors([]);
    setReplayPlan(null);
    setReplays([]);
  }, [selectedProjectId]);

  async function execute() {
    if (!selectedProjectId) return;
    await withBusy('execute', async () => {
      if (!ensureReadyForValidation()) return;
      if (mappingDirty) {
        setError('Mappings changed after verification. Save mappings and run Verify project again before execution.');
        return;
      }
      if (executionOptionsStale) {
        setError('Execution options changed after verification. Run Verify project again before execution.');
        return;
      }
      setLogs([]);
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/execute`, {
        method: 'POST',
        body: {
          mode: executeOptions.mode,
          selectedTables: executeOptions.mode === 'selected' ? selectedTableList : [],
          dryRun: executeOptions.dryRun,
          errorPolicy: executeOptions.errorPolicy,
          concurrency: Number(executeOptions.concurrency || 1),
          batchSize: Number(executeOptions.batchSize || 1000),
          cdcMode: executeOptions.cdcMode,
          loadPhase: executeOptions.loadPhase,
          cutoverMode: executeOptions.cutoverMode,
          watermarkColumn: executeOptions.watermarkColumn || undefined,
          verificationFingerprint: executeOptions.verificationFingerprint || undefined,
          transformFingerprint: executeOptions.transformFingerprint || undefined,
          sourceConnection: workspace.sourceConnection,
          targetConnection: workspace.targetConnection,
        },
        timeoutMs: 120000,
      });
      setSelectedRunId(resp.runId || '');
      await refreshRuns();
      await loadRun(resp.runId);
      streamRun(resp.runId);
      setMessage(`Execution started: ${resp.runId}`);
    });
  }

  async function resumeRun() {
    if (!selectedRunId) return;
    await withBusy('resume-run', async () => {
      await api(`/runs/${encodeURIComponent(selectedRunId)}/resume`, {
        method: 'POST',
        body: buildRuntimeOverrides(workspace),
        timeoutMs: 120000,
      });
      streamRun(selectedRunId);
      setMessage(`Resume scheduled for ${selectedRunId}`);
    });
  }

  async function rerunFailed() {
    if (!selectedRunId) return;
    await withBusy('rerun-failed', async () => {
      const resp = await api(`/runs/${encodeURIComponent(selectedRunId)}/rerun-failed`, {
        method: 'POST',
        body: buildRuntimeOverrides(workspace),
        timeoutMs: 120000,
      });
      setSelectedRunId(resp.runId || '');
      await refreshRuns();
      await loadRun(resp.runId);
      streamRun(resp.runId);
      setMessage(`Rerun started: ${resp.runId}`);
    });
  }

  async function cancelRun() {
    if (!selectedRunId) return;
    await withBusy('cancel-run', async () => {
      await api(`/runs/${encodeURIComponent(selectedRunId)}/cancel`, {
        method: 'POST',
        timeoutMs: 30000,
      });
      await loadRun(selectedRunId).catch(() => null);
      streamRun(selectedRunId);
      setMessage(`Cancellation requested for ${selectedRunId}`);
    });
  }

  async function openRun(runId) {
    setSelectedRunId(runId);
    await loadRun(runId);
    await loadRunReport(runId).catch(() => null);
    await loadCutoverReadiness(runId).catch(() => null);
    const errResp = await api(`/runs/${encodeURIComponent(runId)}/errors`).catch(() => ({ errors: [] }));
    setRunErrors(errResp.errors || []);
    const replayResp = await api(`/runs/${encodeURIComponent(runId)}/replay-errors`, { method: 'POST' }).catch(() => null);
    setReplayPlan(replayResp || null);
    const replayHistory = await api(`/runs/${encodeURIComponent(runId)}/replays`).catch(() => ({ replays: [] }));
    setReplays(replayHistory.replays || []);
  }

  async function importReplayCorrections() {
    if (!selectedRunId || !replayImportJson.trim()) return;
    const parsed = JSON.parse(replayImportJson);
    const resp = await api(`/runs/${encodeURIComponent(selectedRunId)}/replay-import`, {
      method: 'POST',
      body: { ...parsed, sourceConnection: workspace.sourceConnection, targetConnection: workspace.targetConnection },
      timeoutMs: 120000,
    });
    setReplayImportJson('');
    const replayHistory = await api(`/runs/${encodeURIComponent(selectedRunId)}/replays`).catch(() => ({ replays: [] }));
    setReplays(replayHistory.replays || []);
    setMessage(`Replay import completed: ${resp.replay?.summary?.replayed || 0} rows replayed`);
  }

  async function exportErrors() {
    if (!selectedRunId) return;
    const resp = await fetch(resolveApiUrl(`/runs/${encodeURIComponent(selectedRunId)}/errors/export`), { headers: getAuthHeaders() });
    const text = await resp.text();
    downloadText(`${selectedRunId}.errors.json`, text);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Validation & execution" hint="Build dry run refreshes Transform preview, runs Verify project, runs Preflight, then creates a transformed sample preview if there are no blockers." action={<span className="badge">Step 4</span>} />
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <button className="btn" type="button" onClick={() => void verifyProject()} disabled={!selectedProjectId || busy.verify}>{busy.verify ? 'Verifying…' : 'Verify project'}</button>
          <button className="btn" type="button" onClick={() => void runPreflight()} disabled={!selectedProjectId || busy.preflight}>{busy.preflight ? 'Running…' : 'Run preflight'}</button>
          <button className="btn" type="button" onClick={() => void runDryRun()} disabled={!selectedProjectId || busy['dry-run']}>{busy['dry-run'] ? 'Running checks…' : 'Build dry run'}</button>
          <button className="btn primary" type="button" onClick={() => void execute()} disabled={!selectedProjectId || busy.execute || !canExecute}>{busy.execute ? 'Starting…' : 'Execute migration'}</button>
        </div>

        <div className="alert" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800 }}>What do these checks mean?</div>
          <div className="hint" style={{ marginTop: 6 }}><b>Verify project</b> checks mapping completeness, target-schema readiness, and execution gating. <b>Preflight</b> samples source rows and validates transforms/filters. <b>Build dry run</b> now runs both of those first, then shows transformed sample rows without writing to PostgreSQL.</div>
        </div>

        {!canExecute ? (
          <div className="alert warn" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800 }}>Execution gated</div>
            <div className="hint" style={{ marginTop: 6 }}>{executionGateMessage()}</div>
            {verification && topGateIssues.length ? (
              <div style={{ marginTop: 10 }}>
                <div className="hint" style={{ marginBottom: 6 }}>{openVerificationBlockers.length ? 'What to fix before execution:' : 'Warnings to review before execution:'}</div>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {topGateIssues.slice(0, 4).map((item, index) => (
                    <li key={`${item.severity}:${item.kind}:${index}`} className="hint">
                      <b>{item.severity === 'blocker' ? 'Open blocker' : 'Warning'}</b>
                      {item.sourceTable || item.targetTable ? ` (${[item.sourceTable, item.targetTable].filter(Boolean).join(' → ')})` : ''}: {item.message}
                    </li>
                  ))}
                </ul>
                <button className="btn" type="button" style={{ marginTop: 10 }} onClick={() => showVerificationIssues({ view: openVerificationBlockers.length ? 'open' : 'warning', table: '' })}>
                  {openVerificationBlockers.length ? 'Show blocker details' : 'Show warning details'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="alert" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800 }}>Mapping state</div>
          <div className="hint" style={{ marginTop: 6 }}>Current UI table mappings: {(currentProject?.tableMappings || []).length} • Enabled mappings: {enabledUiMappings.length} • Unsaved changes: {mappingDirty ? 'yes' : 'no'}</div>
        </div>
        <div className="alert" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800 }}>Transform state</div>
          <div className="hint" style={{ marginTop: 6 }}>
            {transformPreview?.transformFingerprint
              ? `Preview ${transformScopeCurrent ? 'matches' : 'does not match'} this run scope • Errors: ${transformErrorCount} • Filtered sample rows: ${transformPreview.summary?.filteredSampleRows || 0} • Scope: ${transformPreview.scope?.mode || 'unknown'} / ${transformPreview.scope?.loadPhase || 'configured'}`
              : 'No transform preview for the current saved mappings.'}
          </div>
        </div>
        {!mappingDirty && currentProject ? <MappingSummaryCard project={currentProject} sourceCatalog={sourceCatalog} targetCatalog={targetCatalog} title="Saved mapping summary used for validation" hint="This same persisted summary is what Verify, Preflight, Dry run, and Execute use." /> : null}
        {executeOptions.cdcMode === 'watermark' ? <div className="alert warn" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Incremental mode warning</div><div className="hint" style={{ marginTop: 6 }}>Watermark mode is still groundwork. It does not provide full CDC semantics, delete capture, or robust cutover sync guarantees.</div></div> : null}

        <div className="form-grid">
          <div className="field"><div className="field-label">Run mode</div><select value={executeOptions.mode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, mode: e.target.value }))}><option value="all">all</option><option value="selected">selected</option></select></div>
          <div className="field"><div className="field-label">Error policy</div><select value={executeOptions.errorPolicy} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, errorPolicy: e.target.value }))}><option value="fail-fast">fail-fast</option><option value="quarantine">quarantine</option></select></div>
          <div className="field"><div className="field-label">Concurrency</div><input type="number" min="1" value={executeOptions.concurrency} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, concurrency: e.target.value }))} /></div>
          <div className="field"><div className="field-label">Batch size</div><input type="number" min="1" value={executeOptions.batchSize} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, batchSize: e.target.value }))} /></div>
          <div className="field"><div className="field-label">CDC mode</div><select value={executeOptions.cdcMode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, cdcMode: e.target.value }))}><option value="off">off</option><option value="snapshot-only">snapshot-only</option><option value="watermark">watermark</option></select></div>
          <div className="field"><div className="field-label">Load phase</div><select value={executeOptions.loadPhase} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, loadPhase: e.target.value }))}><option value="configured">configured per table</option><option value="historical">force historical</option><option value="incremental">force incremental</option></select><div className="hint" style={{ marginTop: 6 }}>Configured uses each table's load strategy. Incremental uses persisted watermarks.</div></div>
          <div className="field"><div className="field-label">Cutover mode</div><select value={executeOptions.cutoverMode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, cutoverMode: e.target.value }))}><option value="manual">manual</option><option value="guarded">guarded</option></select></div>
          <div className="field"><div className="field-label">Watermark column</div><input value={executeOptions.watermarkColumn} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, watermarkColumn: e.target.value }))} placeholder="updated_at" disabled={executeOptions.cdcMode !== 'watermark'} /></div>
          <div className="field full"><div className="field-label">Selected tables</div><select multiple value={selectedTableList} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, selectedTables: Array.from(e.target.selectedOptions).map((option) => option.value) }))} disabled={executeOptions.mode !== 'selected'} style={{ minHeight: 120 }}>{enabledTableOptions.map((item) => <option key={item.sourceTable} value={item.sourceTable}>{item.sourceTable} → {item.targetTable}</option>)}</select><div className="hint" style={{ marginTop: 6 }}>Used only when Run mode is selected. Hold Cmd/Ctrl to select multiple tables.</div></div>
          <label className="check full" style={{ gridColumn: 'span 12' }}>
            <input type="checkbox" checked={executeOptions.dryRun} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, dryRun: e.target.checked }))} />
            <span className="field-label" style={{ margin: 0 }}>Mark execution as dry run</span>
          </label>
          <div className="field full"><div className="field-label">Verification token</div><div className="hint mono">{executeOptions.verificationFingerprint || 'Generated after Verify project'}</div></div>
          <div className="field full"><div className="field-label">Transform preview token</div><div className="hint mono">{executeOptions.transformFingerprint || 'Generated after Transform preview'}</div></div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <details className="card" open>
          <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
            <SectionTitle title="Verification" hint="Readiness check for mapping completeness, target provisioning, and load safety." />
          </summary>
          {verificationMeta ? (
            <div className="toolbar" style={{ marginBottom: 12, gap: 8 }}>
              <TrustBadge level={verificationMeta.readiness} label={`Trust: ${verificationMeta.readiness}`} />
              <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'open', table: '' })}>Open blockers: {verificationMeta.openBlockerCount}</button>
              <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'allowed', table: '' })}>Allowed: {verificationMeta.allowedBlockerCount}</button>
              <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'warning', table: '' })}>Warnings: {verificationMeta.warningCount}</button>
              {verificationMeta.nonAllowableBlockerCount ? <span className="badge">Hard stops: {verificationMeta.nonAllowableBlockerCount}</span> : null}
            </div>
          ) : null}
          {verificationIssues.length ? (
            <div ref={issuePanelRef} className="card" style={{ background: 'rgba(255,255,255,0.02)', marginBottom: 12 }}>
              <SectionTitle
                title={verificationIssueView.view === 'warning' ? 'Warnings' : (verificationIssueView.view === 'allowed' ? 'Allowed blockers' : (verificationIssueView.view === 'all' ? 'Verification issues' : 'Open blockers'))}
                hint={verificationIssueView.table ? `Filtered to ${verificationIssueView.table}` : 'Click blocker/warning counts or table issue buttons to change this list.'}
                action={(
                  <div className="toolbar">
                    <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'all', table: '' })}>All</button>
                    <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'open', table: '' })}>Open</button>
                    <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'allowed', table: '' })}>Allowed</button>
                    <button className="btn" type="button" onClick={() => showVerificationIssues({ view: 'warning', table: '' })}>Warnings</button>
                  </div>
                )}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredVerificationIssues.length ? filteredVerificationIssues.map((item, index) => (
                  <div key={`${item.severity}:${item.kind}:${item.sourceTable}:${item.targetTable}:${index}`} className="alert" style={{ marginBottom: 0, borderColor: item.severity === 'blocker' ? 'rgba(220,38,38,0.45)' : 'rgba(217,119,6,0.45)' }}>
                    <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>{item.title}</div>
                        <div className="hint" style={{ marginTop: 6 }}>
                          {item.sourceTable || item.targetTable ? [item.sourceTable, item.targetTable].filter(Boolean).join(' → ') : item.scope}
                          {item.kind ? ` • ${formatIssueKind(item.kind)}` : ''}
                        </div>
                      </div>
                      <span className="badge">{item.severity}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>{item.message}</div>
                    {item.severity === 'blocker' ? (
                      <div className="toolbar" style={{ marginTop: 10 }}>
                        {item.status === 'allowed' ? (
                          <>
                            <span className="badge">Allowed</span>
                            <span className="hint">Reason: {item.allowance?.reason || '—'}</span>
                            <button className="btn" type="button" onClick={() => void revokeVerificationIssue(item)} disabled={busy['verification-allowances']}>Revoke</button>
                          </>
                        ) : item.allowable ? (
                          <button className="btn" type="button" onClick={() => void allowVerificationIssue(item)} disabled={busy['verification-allowances']}>Allow with reason</button>
                        ) : (
                          <span className="hint">Cannot be allowed: {item.nonAllowableReason || 'Fix this blocker before loading.'}</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                )) : <div className="hint">No issues match this filter.</div>}
              </div>
            </div>
          ) : null}
          {verification?.tableReadiness?.length ? (
            <div className="schema-table-scroll" style={{ marginBottom: 12 }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Source</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Target</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Readiness</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Completeness</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Schema action</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Open</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Allowed</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Warnings</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Issues</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.tableReadiness.map((item) => (
                    <tr key={`${item.sourceTable}:${item.targetTable}`}>
                      <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.sourceTable}</td>
                      <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.targetTable || '—'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{readinessBadge(item.readiness?.level)}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.completeness?.level || '—'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.schemaAction || '—'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.openBlockerCount ?? item.blockerCount ?? 0}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.allowedBlockerCount || 0}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.warningCount}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        {((item.openBlockerCount ?? item.blockerCount ?? 0) || item.allowedBlockerCount || item.warningCount) ? (
                          <button className="btn" type="button" onClick={() => showVerificationIssues({ view: (item.openBlockerCount ?? item.blockerCount ?? 0) ? 'open' : (item.allowedBlockerCount ? 'allowed' : 'warning'), table: item.sourceTable || item.targetTable || '' })}>View details</button>
                        ) : '—'}
                      </td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><span className="hint">{readinessNextStep(item)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {verification?.pendingSchemaActions?.length ? (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Pending schema actions</div>
              <div className="hint" style={{ marginTop: 6 }}>{verification.pendingSchemaActions.map((item) => `${item.targetTable || item.sourceTable}: ${describeSchemaAction(item.action)}`).join(' • ')}</div>
            </div>
          ) : null}
          {verification?.hardBlockingSchemaIssues?.length ? (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Hard schema blockers</div>
              <div className="hint" style={{ marginTop: 6 }}>
                {verification.hardBlockingSchemaIssues.map((item) => {
                  const details = [
                    ...(item.issues || []).map((issue) => describeVerificationIssue(issue, item)),
                    ...(item.readiness?.reasons || []).map(formatReadinessReason),
                  ].filter(Boolean).slice(0, 3);
                  return `${item.targetTable || item.sourceTable}: ${describeSchemaAction(item.action)}${details.length ? ` ${details.join(' ')}` : ''}`;
                }).join(' • ')}
              </div>
            </div>
          ) : null}
          {verification?.executionPlan?.steps?.length ? (
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', marginBottom: 12 }}>
              <SectionTitle title="Execution plan" hint="Dependency-aware table execution order used for safer loading." />
              <div className="schema-table-scroll">
                <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 8 }}>Order</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Source</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Target</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Mode</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Depends on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verification.executionPlan.steps.map((step) => (
                      <tr key={`${step.order}:${step.sourceTable}`}>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{step.order}</td>
                        <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{step.sourceTable}</td>
                        <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{step.targetTable || '—'}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{step.writeMode}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(step.dependsOn || []).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {verification.executionPlan.cyclesDetected?.length ? <div className="hint" style={{ marginTop: 10 }}>Cycle/unresolved order fallback used for: {verification.executionPlan.cyclesDetected.join(', ')}</div> : null}
            </div>
          ) : null}
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{verification ? formatJson(verification) : '—'}</div>
        </details>
        <details className="card">
          <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
            <SectionTitle title="Incremental watermarks" hint="Project/table-level state used by incremental loads. You can set a baseline or reset a table to reload from its configured baseline." action={<button className="btn" type="button" onClick={() => void loadWatermarks()} disabled={!selectedProjectId}>Refresh</button>} />
          </summary>
          <div className="schema-table-scroll" style={{ marginBottom: 12 }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={{ textAlign: 'left', padding: 8 }}>Table</th><th style={{ textAlign: 'left', padding: 8 }}>Watermark</th><th style={{ textAlign: 'left', padding: 8 }}>Tie-breaker</th><th style={{ textAlign: 'left', padding: 8 }}>Last value</th><th style={{ textAlign: 'left', padding: 8 }}>Actions</th></tr></thead>
              <tbody>{(currentProject?.tableMappings || []).filter((mapping) => mapping.enabled !== false).map((mapping) => {
                const state = watermarks?.tables?.[mapping.sourceTable] || {};
                const strategy = mapping.loadStrategy || {};
                return <tr key={mapping.sourceTable}><td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{mapping.sourceTable}</td><td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{state.watermarkColumn || strategy.watermarkColumn || mapping.watermarkColumn || '—'}</td><td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{state.tieBreakerColumn || strategy.tieBreakerColumn || 'auto'}</td><td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{state.lastWatermark ?? strategy.baselineWatermark ?? 'not set'}{state.lastTieBreaker != null ? ` / ${state.lastTieBreaker}` : ''}</td><td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><div className="toolbar"><button className="btn" type="button" onClick={() => void setWatermarkBaseline(mapping.sourceTable)}>Set baseline</button><button className="btn danger" type="button" onClick={() => void resetWatermark(mapping.sourceTable)}>Reset</button></div></td></tr>;
              })}</tbody>
            </table>
          </div>
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{watermarks ? formatJson(watermarks) : '—'}</div>
        </details>
        <details className="card">
          <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
            <SectionTitle title="Preflight report" hint="Blockers and warnings based on table mappings and sample source rows." />
          </summary>
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{preflightReport ? formatJson(preflightReport) : '—'}</div>
        </details>
        <details className="card">
          <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
            <SectionTitle title="Dry run preview" hint="Shows sample transformed rows using current column mappings." action={dryRunPreview?.sqlText ? <button className="btn" type="button" onClick={downloadDryRunSql}>Download SQL (.sql)</button> : null} />
          </summary>
          {dryRunPreview?.sqlText ? <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', marginBottom: 12 }}>{dryRunPreview.sqlText}</div> : null}
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{dryRunPreview ? formatJson(dryRunPreview) : '—'}</div>
        </details>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="card">
          <SectionTitle
            title="Runs"
            hint="Select a run to inspect current status or generate a final validation report."
            action={<div className="toolbar"><button className="btn" type="button" onClick={() => void resumeRun()} disabled={!selectedRunId || busy['resume-run']}>{busy['resume-run'] ? 'Scheduling…' : 'Resume'}</button><button className="btn" type="button" onClick={() => void rerunFailed()} disabled={!selectedRunId || busy['rerun-failed']}>{busy['rerun-failed'] ? 'Starting…' : 'Rerun failed'}</button><button className="btn danger" type="button" onClick={() => void cancelRun()} disabled={!selectedRunId || !['queued', 'running'].includes(currentRun?.status) || busy['cancel-run']}>{busy['cancel-run'] ? 'Cancelling…' : 'Cancel'}</button></div>}
          />
          <div className="schema-table-scroll">
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Run</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Project</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Rows</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} style={{ cursor: 'pointer', background: run.id === selectedRunId ? 'rgba(59,130,246,0.14)' : 'transparent' }} onClick={() => void openRun(run.id)}>
                    <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.id}</td>
                    <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.projectId}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.status}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.counters?.rowsInserted || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <SectionTitle title="Run details" hint="Live run state plus post-run validation report." />
          <div className="hint">Current run: <span className="mono">{currentRun?.id || '—'}</span></div>
          <div className="hint" style={{ marginTop: 6 }}>Status: {currentRun?.status || '—'}</div>
          <div className="hint" style={{ marginTop: 6 }}>Consistency mode: {runReport?.summary?.consistencyMode || currentRun?.executionProfile?.consistencyMode || '—'}</div>
          <div className="hint" style={{ marginTop: 6 }}>Scheduler: {runReport?.summary?.scheduler || currentRun?.executionProfile?.scheduler || '—'}</div>
          <div className="hint" style={{ marginTop: 6 }}>Counters: {currentRun ? formatJson(currentRun.counters || {}) : '—'}</div>
          <div style={{ height: 12 }} />
          {runReport?.audit ? (
            <div className="toolbar" style={{ marginBottom: 12, gap: 8 }}>
              <TrustBadge level={runReport.audit.trustLevel} label={`Audit: ${runReport.audit.trustLevel}`} />
              <span className="badge">Confidence: {runReport.audit.confidenceScore ?? '—'}</span>
              <span className="badge">Row mismatches: {runReport.validation?.rowCountMismatches ?? 0}</span>
              <span className="badge">Aggregate mismatches: {runReport.validation?.aggregateMismatches ?? 0}</span>
              <span className="badge">Key mismatches: {runReport.validation?.keyCoverageMismatches ?? 0}</span>
            </div>
          ) : null}
          {runReport?.tableVerification?.length ? (
            <div className="schema-table-scroll" style={{ marginBottom: 12 }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Table</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Source rows</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Target rows</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Match</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Trust</th>
                  </tr>
                </thead>
                <tbody>
                  {runReport.tableVerification.map((item) => (
                    <tr key={`${item.tableName}:${item.targetTable}`}>
                      <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.tableName}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.sourceRowCount ?? '—'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.targetRowCount ?? '—'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.rowCountMatch == null ? 'n/a' : item.rowCountMatch ? 'yes' : 'no'}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><TrustBadge level={item.trustLevel} label={item.trustLevel || '—'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {runReport?.audit?.recommendations?.length ? <div className="hint" style={{ marginBottom: 12 }}>{renderWarningList(runReport.audit.recommendations)}</div> : null}
          {cutoverReport ? (
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)', marginBottom: 12 }}>
              <SectionTitle title="Cutover readiness" hint="Final recommendation based on verification, mismatches, replayable errors, and consistency mode." />
              <div className="toolbar" style={{ gap: 8, marginBottom: 10 }}>
                <TrustBadge level={cutoverReport.readiness === 'ready' ? 'verified' : (cutoverReport.readiness === 'ready_with_exceptions' ? 'verified_with_warnings' : 'needs_manual_review')} label={`State: ${cutoverReport.readiness}`} />
                <span className="badge">Consistency: {cutoverReport.consistencyMode}</span>
                <span className="badge">CDC: {cutoverReport.cdcMode}</span>
                <span className="badge">Replayable errors: {cutoverReport.replayableErrors}</span>
              </div>
              <div className="hint">{renderWarningList(cutoverReport.recommendations || [])}</div>
            </div>
          ) : null}
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{runReport ? formatJson(runReport) : '—'}</div>
          <div style={{ height: 12 }} />
          <SectionTitle title="Rejected rows / errors" hint="Stored row-level and table-level failures for inspection." action={<button className="btn" type="button" onClick={() => void exportErrors()} disabled={!selectedRunId}>Export errors</button>} />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{runErrors.length ? formatJson(runErrors) : '—'}</div>
          {runErrors.length ? <div className="hint" style={{ marginTop: 8 }}>Error classes: {Array.from(new Set(runErrors.map((item) => item.context?.phase || 'unknown'))).join(', ')}</div> : null}
          <div style={{ height: 12 }} />
          <SectionTitle title="Replay guidance" hint="Shows which rows are replayable after manual correction." />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{replayPlan ? formatJson(replayPlan) : '—'}</div>
          <div style={{ height: 12 }} />
          <SectionTitle title="Replay import" hint="Paste corrected replay payload JSON and apply it to the target." action={<button className="btn" type="button" onClick={() => void importReplayCorrections()} disabled={!selectedRunId || !replayImportJson.trim()}>Import replay corrections</button>} />
          <textarea value={replayImportJson} onChange={(e) => setReplayImportJson(e.target.value)} placeholder='{"corrections":[{"errorId":"...","tableName":"users","sourceRow":{...}}]}' style={{ minHeight: 120 }} />
          <div style={{ height: 12 }} />
          <SectionTitle title="Replay history" hint="Replay attempts already persisted for this run." />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{replays.length ? formatJson(replays) : '—'}</div>
        </div>
      </div>

      <div className="card">
        <SectionTitle title="Live logs" hint="Streaming server-sent events emitted by the backend execution engine." />
        <div className="mono" style={{ whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 12, minHeight: 220, maxHeight: 320, overflow: 'auto' }}>
          {logs.length ? logs.map((entry) => `[${entry.at}] ${entry.level || 'info'} ${entry.message || formatJson(entry)}`).join('\n') : '—'}
        </div>
      </div>
    </div>
  );
}

function HistoryScreen() {
  const { projects, runs, loadProject, setSelectedProjectId, loadRun, setSelectedRunId, currentProject, currentRun, refreshProjects, refreshRuns, withBusy, busy, setMessage, setTab } = useApp();
  const [importJson, setImportJson] = useState('');

  async function exportProject(projectId) {
    await withBusy('export-project', async () => {
      const resp = await fetch(resolveApiUrl(`/projects/${encodeURIComponent(projectId)}/export`), { headers: getAuthHeaders() });
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
      const text = await resp.text();
      downloadText(`${projectId}.mapping.json`, text);
      setMessage(`Exported ${projectId}`);
    });
  }

  async function importProject() {
    await withBusy('import-project', async () => {
      const parsed = JSON.parse(importJson || '{}');
      const resp = await api('/projects/import', { method: 'POST', body: parsed, timeoutMs: 120000 });
      await refreshProjects();
      setSelectedProjectId(resp.project?.id || '');
      await loadProject(resp.project?.id || '', { loadIntoWorkspace: true });
      setMessage(`Imported project ${resp.project?.id || ''}`.trim());
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <SectionTitle title="Projects" hint="Persisted manual migration projects and export/import support." action={<button className="btn" type="button" onClick={() => void refreshProjects()}>Refresh</button>} />
          <div className="schema-table-scroll">
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Name</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Mappings</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Updated</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ fontWeight: 800 }}>{project.name}</div>
                      <div className="hint mono" style={{ marginTop: 6 }}>{project.id}</div>
                    </td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{project.mappingSummary?.mappedTables ?? project.tableMappings?.filter?.((mapping) => mapping?.targetTable)?.length ?? 0}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{project.updatedAt || project.createdAt || '—'}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <div className="toolbar">
                        <button className="btn" type="button" onClick={() => { setSelectedProjectId(project.id); void loadProject(project.id).then(() => setTab('mapping')); }}>Open mappings</button>
                        <button className="btn" type="button" onClick={() => { setSelectedProjectId(project.id); void loadProject(project.id, { loadIntoWorkspace: true }).then(() => setTab('workspace')); }}>Load workspace</button>
                        <button className="btn" type="button" onClick={() => void exportProject(project.id)} disabled={busy['export-project']}>Export</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <SectionTitle title="Import mapping JSON" hint="Paste an exported project JSON file to restore it into local state storage on the server." />
          <textarea value={importJson} onChange={(e) => setImportJson(e.target.value)} placeholder="Paste project JSON here…" style={{ minHeight: 260 }} />
          <div style={{ height: 12 }} />
          <button className="btn primary" type="button" onClick={() => void importProject()} disabled={busy['import-project']}>{busy['import-project'] ? 'Importing…' : 'Import project'}</button>
        </div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <SectionTitle title="Run history" hint="All known runs in persistence storage." action={<button className="btn" type="button" onClick={() => void refreshRuns()}>Refresh</button>} />
          <div className="schema-table-scroll">
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Run</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><button className="btn" type="button" onClick={() => { setSelectedRunId(run.id); void loadRun(run.id); }}>{run.id}</button></td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.status}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{run.createdAt || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <SectionTitle title="Current selection" hint="Quick summary of the currently loaded project/run." />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{formatJson({ currentProject, currentRun })}</div>
        </div>
      </div>
    </div>
  );
}

function SettingsScreen() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <FirstRunChecklist />
      <div className="grid">
      <div className="card">
        <h3>How this tool works today</h3>
        <div className="hint">This UI now drives backend APIs for introspection, manual mapping, schema planning, target provisioning, verification, preview, execution, and report retrieval.</div>
        <ul style={{ marginTop: 12, paddingLeft: 20 }}>
          <li>Projects are persisted under <span className="mono">mysql-pg-migrate/state/projects</span>.</li>
          <li>Runs, reports, checkpoints, and errors are persisted under sibling state folders.</li>
          <li>Passwords remain only in browser memory/local form state and are not persisted by the UI.</li>
          <li>Transform is now first-class: preview row filters, value maps, expressions, constants, templates, and lookup-table joins before load.</li>
        </ul>
      </div>
      <div className="card">
        <h3>Current platform status</h3>
        <div className="alert warn">
          <div style={{ fontWeight: 800 }}>Real ETL workflow, still early-stage</div>
          <div className="hint" style={{ marginTop: 6 }}>
            The backend can now introspect source/target schemas, let you define mappings, provision missing target tables, verify readiness, and execute real row movement. However, it is still an early-stage ETL system and should be used carefully with verification and staging-first practices.
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

const TABS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'mapping', label: 'Mapping' },
  { id: 'transform', label: 'Transform' },
  { id: 'validate-run', label: 'Validate & Run' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

function App() {
  const { tab, setTab, message, error, alertRef } = useApp();

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div>
            <h1>mysql-pg-migrate</h1>
            <div className="subtitle">MySQL → PostgreSQL migration workspace</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="tabs" role="tablist" aria-label="Sections">
            {TABS.map((item) => (
              <button key={item.id} className="tab" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <ProjectStatusBadge />
            <span className="badge">API: /api</span>
          </div>
        </div>

        <div className="panel-body">
          <div ref={alertRef} />
          {message ? <div className="alert" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Info</div><div className="hint" style={{ marginTop: 6 }}>{message}</div></div> : null}
          {error ? <div className="alert warn" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Error</div><div className="hint" style={{ marginTop: 6 }}>{error}</div></div> : null}
          {tab === 'workspace' && <WorkspaceScreen />}
          {tab === 'mapping' && <MappingScreen />}
          {tab === 'transform' && <TransformScreen />}
          {tab === 'validate-run' && <ValidateRunScreen />}
          {tab === 'history' && <HistoryScreen />}
          {tab === 'settings' && <SettingsScreen />}
        </div>
      </div>
    </div>
  );
}

export default function MysqlPgMigrateTool({ runtime: toolRuntime }) {
  setRuntime(toolRuntime || STANDALONE_RUNTIME);
  return (
    <AppProvider>
      <App />
    </AppProvider>
  );
}

const standaloneRoot = typeof document !== 'undefined' ? document.getElementById('root') : null;

if (standaloneRoot?.dataset?.tool === 'mysql-pg-migrate') {
  const root = standaloneRoot.__mysqlPgMigrateRoot || createRoot(standaloneRoot);
  standaloneRoot.__mysqlPgMigrateRoot = root;
  root.render(
    <React.StrictMode>
      <MysqlPgMigrateTool runtime={STANDALONE_RUNTIME} />
    </React.StrictMode>
  );
}
