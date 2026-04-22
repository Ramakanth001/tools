import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../pg-backup/src/ui/styles/global.css';

const DEFAULT_RUNTIME = {
  toolId: 'mysql-pg-migrate',
  apiBasePath: '/api',
  homePath: '/',
  storagePrefix: 'mysql-pg-migrate',
};

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

async function api(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('Request timeout')), timeoutMs);
  try {
    const resp = await fetch(resolveApiUrl(path), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  const ev = new EventSource(resolveApiUrl(`/runs/${encodeURIComponent(runId)}/events`));
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
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(getStorageKey(key), JSON.stringify(value));
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
  return { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', sslMode: 'PREFERRED', connectionString: '', ref: '', consistentRead: { enabled: false, isolation: 'REPEATABLE READ' } };
}

function defaultTargetConnection() {
  return {
    ref: '',
    connectionString: '',
    pooler: { host: '127.0.0.1', port: 5432, user: 'postgres', database: '', password: '', sslmode: 'require' },
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

const AppContext = createContext(null);

function AppProvider({ children }) {
  const [tab, setTab] = useState(() => localStorage.getItem(getStorageKey('tab')) || 'workspace');
  const [workspace, setWorkspace] = useState(() => loadLocal('workspace', defaultContextState()));
  const [projects, setProjects] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem(getStorageKey('selected_project_id')) || '');
  const [selectedRunId, setSelectedRunId] = useState(() => localStorage.getItem(getStorageKey('selected_run_id')) || '');
  const [currentProject, setCurrentProject] = useState(null);
  const [currentRun, setCurrentRun] = useState(null);
  const [preflightReport, setPreflightReport] = useState(null);
  const [dryRunPreview, setDryRunPreview] = useState(null);
  const [runReport, setRunReport] = useState(null);
  const [cutoverReport, setCutoverReport] = useState(null);
  const [introspection, setIntrospection] = useState(null);
  const [sourceSchemas, setSourceSchemas] = useState([]);
  const [targetSchemas, setTargetSchemas] = useState([]);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState([]);
  const [transformCatalog, setTransformCatalog] = useState([]);
  const eventSourceRef = useRef(null);

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

  async function loadProject(projectId) {
    if (!projectId) {
      setCurrentProject(null);
      return null;
    }
    const resp = await api(`/projects/${encodeURIComponent(projectId)}`);
    setCurrentProject(resp.project || null);
    setSelectedProjectId(resp.project?.id || '');
    return resp.project || null;
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
    const resp = await api(`/runs/${encodeURIComponent(runId)}/report`);
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
    if (selectedProjectId) void loadProject(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedRunId) {
      void loadRun(selectedRunId);
      void loadRunReport(selectedRunId).catch(() => null);
    }
  }, [selectedRunId]);

  const value = useMemo(() => ({
    tab, setTab,
    workspace, setWorkspace,
    projects, runs,
    selectedProjectId, setSelectedProjectId,
    selectedRunId, setSelectedRunId,
    currentProject, setCurrentProject,
    currentRun, setCurrentRun,
    preflightReport, setPreflightReport,
    dryRunPreview, setDryRunPreview,
    runReport, setRunReport,
    cutoverReport, setCutoverReport,
    introspection, setIntrospection,
    sourceSchemas, setSourceSchemas,
    targetSchemas, setTargetSchemas,
    busy, withBusy,
    message, setMessage,
    error, setError,
    logs, setLogs,
    transformCatalog,
    refreshProjects, refreshRuns, loadProject, loadRun, loadRunReport, streamRun,
  }), [tab, workspace, projects, runs, selectedProjectId, selectedRunId, currentProject, currentRun, preflightReport, dryRunPreview, runReport, cutoverReport, introspection, sourceSchemas, targetSchemas, busy, message, error, logs, transformCatalog]);

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

  function patchSource(patch) {
    setWorkspace((curr) => ({ ...curr, sourceConnection: { ...curr.sourceConnection, ...patch } }));
  }

  function patchTarget(patch) {
    setWorkspace((curr) => ({ ...curr, targetConnection: { ...curr.targetConnection, ...patch, pooler: { ...curr.targetConnection.pooler, ...(patch.pooler || {}) } } }));
  }

  async function fetchSourceSchemas() {
    await withBusy('source-schemas', async () => {
      const resp = await api('/connections/source/schemas', { method: 'POST', body: { sourceConnection: source } });
      setSourceSchemas(resp.schemas || []);
      if (!workspace.sourceSchema && resp.schemas?.length) {
        setWorkspace((curr) => ({ ...curr, sourceSchema: resp.schemas[0] }));
      }
      setMessage('Loaded MySQL schemas');
    });
  }

  async function fetchTargetSchemas() {
    await withBusy('target-schemas', async () => {
      const resp = await api('/connections/target/schemas', { method: 'POST', body: { targetConnection: target } });
      setTargetSchemas(resp.schemas || []);
      if (!workspace.targetSchema && resp.schemas?.length) {
        setWorkspace((curr) => ({ ...curr, targetSchema: resp.schemas[0] }));
      }
      setMessage('Loaded PostgreSQL schemas');
    });
  }

  return (
    <div className="grid" style={{ alignItems: 'start' }}>
      <div className="card">
        <SectionTitle
          title="Source MySQL"
          hint="Provide the source database connection. Password stays in-memory in the browser session."
          action={<button className="btn" type="button" onClick={() => void fetchSourceSchemas()} disabled={busy['source-schemas']}>{busy['source-schemas'] ? 'Loading…' : 'Load schemas'}</button>}
        />
        <div className="form-grid">
          <div className="field"><div className="field-label">Host</div><input value={source.host} onChange={(e) => patchSource({ host: e.target.value })} /></div>
          <div className="field"><div className="field-label">Port</div><input type="number" value={source.port} onChange={(e) => patchSource({ port: Number(e.target.value || 3306) })} /></div>
          <div className="field"><div className="field-label">User</div><input value={source.user} onChange={(e) => patchSource({ user: e.target.value })} /></div>
          <div className="field"><div className="field-label">Database</div><input value={source.database} onChange={(e) => patchSource({ database: e.target.value })} /></div>
          <div className="field"><div className="field-label">SSL mode</div><select value={source.sslMode} onChange={(e) => patchSource({ sslMode: e.target.value })}><option>PREFERRED</option><option>REQUIRED</option><option>DISABLED</option><option>VERIFY_CA</option><option>VERIFY_IDENTITY</option></select></div>
          <label className="check"><input type="checkbox" checked={source.consistentRead?.enabled === true} onChange={(e) => patchSource({ consistentRead: { ...(source.consistentRead || {}), enabled: e.target.checked } })} /><span className="field-label" style={{ margin: 0 }}>Consistent read</span></label>
          <div className="field"><div className="field-label">Read isolation</div><select value={source.consistentRead?.isolation || 'REPEATABLE READ'} onChange={(e) => patchSource({ consistentRead: { ...(source.consistentRead || {}), isolation: e.target.value } })}><option>READ COMMITTED</option><option>REPEATABLE READ</option><option>SERIALIZABLE</option></select></div>
          <div className="field"><div className="field-label">Reference</div><input value={source.ref || ''} onChange={(e) => patchSource({ ref: e.target.value })} placeholder="optional saved label" /></div>
          <div className="field full"><div className="field-label">Password</div><input type="password" value={source.password} onChange={(e) => patchSource({ password: e.target.value })} /></div>
          <div className="field full"><div className="field-label">Connection string</div><input value={source.connectionString || ''} onChange={(e) => patchSource({ connectionString: e.target.value })} placeholder="optional mysql://... reference" /></div>
          <div className="field full"><div className="field-label">Schema</div><select value={workspace.sourceSchema} onChange={(e) => setWorkspace((curr) => ({ ...curr, sourceSchema: e.target.value }))}><option value="">— select source schema —</option>{sourceSchemas.map((schema) => <option key={schema} value={schema}>{schema}</option>)}</select></div>
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
          <div className="field"><div className="field-label">SSL mode</div><select value={target.pooler.sslmode} onChange={(e) => patchTarget({ pooler: { sslmode: e.target.value } })}><option value="require">require</option><option value="disable">disable</option><option value="allow">allow</option><option value="prefer">prefer</option><option value="verify-full">verify-full</option></select></div>
          <div className="field"><div className="field-label">Reference</div><input value={target.ref || ''} onChange={(e) => patchTarget({ ref: e.target.value })} placeholder="optional saved label" /></div>
          <div className="field full"><div className="field-label">Password</div><input type="password" value={target.pooler.password || ''} onChange={(e) => patchTarget({ pooler: { password: e.target.value } })} /></div>
          <div className="field full"><div className="field-label">Schema</div><select value={workspace.targetSchema} onChange={(e) => setWorkspace((curr) => ({ ...curr, targetSchema: e.target.value }))}><option value="">— select target schema —</option>{targetSchemas.map((schema) => <option key={schema} value={schema}>{schema}</option>)}</select></div>
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
  const { workspace, setWorkspace, introspection, setIntrospection, setCurrentProject, setSelectedProjectId, refreshProjects, withBusy, busy, setMessage } = useApp();

  async function introspect() {
    await withBusy('introspect', async () => {
      const resp = await api('/introspect', { method: 'POST', body: workspace, timeoutMs: 120000 });
      setIntrospection(resp);
      setMessage('Schema introspection completed');
    });
  }

  async function createProject() {
    await withBusy('create-project', async () => {
      const payload = { ...workspace, name: workspace.name || `migration-${Date.now()}` };
      const resp = await api('/projects', { method: 'POST', body: payload, timeoutMs: 120000 });
      setCurrentProject(resp.project || null);
      setSelectedProjectId(resp.project?.id || '');
      await refreshProjects();
      setMessage(`Created project ${resp.project?.name || ''}`.trim());
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Migration workspace" hint="Connect source and target, introspect both catalogs, and create a persisted migration project." action={<span className="badge">Step 1</span>} />
        <div className="field full" style={{ marginBottom: 14 }}>
          <div className="field-label">Project name</div>
          <input value={workspace.name} onChange={(e) => setWorkspace((curr) => ({ ...curr, name: e.target.value }))} placeholder="e.g. billing-mysql-to-pg" />
        </div>
        <ConnectionFields />
        <div style={{ height: 16 }} />
        <div className="toolbar">
          <button className="btn" type="button" onClick={() => void introspect()} disabled={busy.introspect}>{busy.introspect ? 'Introspecting…' : 'Introspect schemas'}</button>
          <button className="btn primary" type="button" onClick={() => void createProject()} disabled={busy['create-project']}>{busy['create-project'] ? 'Creating…' : 'Create auto-mapped project'}</button>
        </div>
      </div>

      {introspection ? (
        <div className="grid" style={{ alignItems: 'start' }}>
          <div className="card">
            <h3>Source catalog</h3>
            <div className="hint">Tables: {introspection.source?.tables?.length || 0}</div>
            <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>{formatJson(introspection.source || {})}</div>
          </div>
          <div className="card">
            <h3>Target catalog</h3>
            <div className="hint">Tables: {introspection.target?.tables?.length || 0}</div>
            <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>{formatJson(introspection.target || {})}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MappingScreen() {
  const { currentProject, setCurrentProject, selectedProjectId, projects, setSelectedProjectId, refreshProjects, loadProject, withBusy, busy, setMessage, transformCatalog } = useApp();
  const [schemaPlan, setSchemaPlan] = useState(null);
  const [manualAdd, setManualAdd] = useState({ sourceTable: '', targetTable: '', mode: 'existing' });

  async function saveProject() {
    if (!currentProject?.id) return;
    await withBusy('save-project', async () => {
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}`, {
        method: 'PUT',
        body: { name: currentProject.name, notes: currentProject.notes || '', tableMappings: currentProject.tableMappings || [] },
        timeoutMs: 120000,
      });
      setCurrentProject(resp.project || null);
      await refreshProjects();
      setMessage('Saved project mappings');
    });
  }

  async function autoMap() {
    if (!currentProject?.id) return;
    await withBusy('auto-map', async () => {
      const resp = await api(`/projects/${encodeURIComponent(currentProject.id)}/auto-map`, { method: 'POST', timeoutMs: 120000 });
      setCurrentProject(resp.project || null);
      await refreshProjects();
      setMessage('Re-generated auto mappings');
    });
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
        body: { targetConnection: currentProject.targetConnection },
        timeoutMs: 120000,
      });
      setSchemaPlan(resp.plan || null);
      setCurrentProject(resp.project || null);
      await refreshProjects();
      setMessage(`Provisioned ${resp.created?.length || 0} target tables`);
    });
  }

  function patchTable(index, patch) {
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next[index] = { ...next[index], ...patch };
      return { ...curr, tableMappings: next };
    });
  }

  function patchColumn(tableIndex, colIndex, patch) {
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

  function addManualTableMapping() {
    if (!manualAdd.sourceTable.trim()) return;
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next.push({
        id: `${manualAdd.sourceTable}:${Date.now()}`,
        sourceTable: manualAdd.sourceTable.trim(),
        targetTable: manualAdd.targetTable.trim() || null,
        targetTableMode: manualAdd.mode,
        createTargetTable: manualAdd.mode === 'create_new',
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
    setManualAdd({ sourceTable: '', targetTable: '', mode: 'existing' });
  }

  function removeTableMapping(index) {
    setCurrentProject((curr) => {
      if (!curr) return curr;
      const next = [...(curr.tableMappings || [])];
      next.splice(index, 1);
      return { ...curr, tableMappings: next.map((item, order) => ({ ...item, order })) };
    });
  }

  const targetTableNames = currentProject?.targetCatalog?.tables?.map((table) => table.name) || [];
  const sourceTableNames = currentProject?.sourceCatalog?.tables?.map((table) => table.name) || [];
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
        <SectionTitle title="Project mappings" hint="Review the generated table and column mappings before validation or execution." action={<span className="badge">Step 2</span>} />
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <select value={selectedProjectId} onChange={(e) => { setSelectedProjectId(e.target.value); void loadProject(e.target.value); }}>
            <option value="">— Select project —</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.id})</option>)}
          </select>
          <button className="btn" type="button" onClick={() => void autoMap()} disabled={!currentProject?.id || busy['auto-map']}>{busy['auto-map'] ? 'Rebuilding…' : 'Re-run auto map'}</button>
          <button className="btn primary" type="button" onClick={() => void saveProject()} disabled={!currentProject?.id || busy['save-project']}>{busy['save-project'] ? 'Saving…' : 'Save project'}</button>
        </div>

        {!currentProject ? (
          <div className="hint">Create or load a project from the Workspace tab first.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <SectionTitle title="Add manual table mapping" hint="Define source → target relationships directly instead of depending only on auto-map suggestions." />
              <div className="form-grid">
                <div className="field"><div className="field-label">Source table</div><input value={manualAdd.sourceTable} onChange={(e) => setManualAdd((curr) => ({ ...curr, sourceTable: e.target.value }))} list="source-table-options" placeholder="source table" /></div>
                <datalist id="source-table-options">{sourceTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</datalist>
                <div className="field"><div className="field-label">Target table mode</div><select value={manualAdd.mode} onChange={(e) => setManualAdd((curr) => ({ ...curr, mode: e.target.value }))}><option value="existing">use existing</option><option value="create_new">create new</option></select></div>
                <div className="field"><div className="field-label">Target table</div><input value={manualAdd.targetTable} onChange={(e) => setManualAdd((curr) => ({ ...curr, targetTable: e.target.value }))} list="target-table-options" placeholder="target table" /></div>
                <datalist id="target-table-options">{targetTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</datalist>
                <div className="field" style={{ justifyContent: 'flex-end' }}><div className="field-label" style={{ opacity: 0 }}>.</div><button className="btn primary" type="button" onClick={addManualTableMapping}>Add mapping</button></div>
              </div>
            </div>

            <div className="field full">
              <div className="field-label">Notes</div>
              <textarea value={currentProject.notes || ''} onChange={(e) => setCurrentProject((curr) => ({ ...curr, notes: e.target.value }))} style={{ minHeight: 90 }} />
            </div>

            <div className="alert" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 800 }}>Mapping readiness</div>
              <div className="hint" style={{ marginTop: 6 }}>{verificationReady ? 'Basic mapping completeness looks OK. You can proceed to verification.' : 'Some enabled mappings still need source/target table decisions before verification/load.'}</div>
            </div>

            {(currentProject.tableMappings || []).map((mapping, tableIndex) => (
              <div key={mapping.id} className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{mapping.sourceTable}</div>
                    <div className="hint">Confidence: {mapping.confidence ?? 'n/a'} • {mapping.rationale?.join(', ') || 'manual review recommended'}</div>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={mapping.enabled !== false} onChange={(e) => patchTable(tableIndex, { enabled: e.target.checked })} />
                    <span className="field-label" style={{ margin: 0 }}>Enabled</span>
                  </label>
                  <button className="btn danger" type="button" onClick={() => removeTableMapping(tableIndex)}>Remove</button>
                </div>

                <div className="form-grid" style={{ marginTop: 12 }}>
                  <div className="field"><div className="field-label">Target table mode</div><select value={mapping.targetTableMode || 'existing'} onChange={(e) => patchTable(tableIndex, { targetTableMode: e.target.value, createTargetTable: e.target.value === 'create_new' })}><option value="existing">use existing table</option><option value="create_new">create new table</option></select></div>
                  <div className="field"><div className="field-label">Target table</div><input value={mapping.targetTable || ''} onChange={(e) => patchTable(tableIndex, { targetTable: e.target.value || null })} placeholder={mapping.targetTableMode === 'create_new' ? 'new target table name' : 'existing target table name'} list={`target-table-list-${tableIndex}`} /></div>
                  <datalist id={`target-table-list-${tableIndex}`}>{targetTableNames.map((name) => <option key={name} value={name}>{name}</option>)}</datalist>
                  <div className="field"><div className="field-label">Write mode</div><select value={mapping.writeMode || 'append'} onChange={(e) => patchTable(tableIndex, { writeMode: e.target.value })}><option value="append">append</option><option value="truncate">truncate</option><option value="upsert">upsert</option></select></div>
                  <div className="field"><div className="field-label">Conflict strategy</div><select value={mapping.conflictStrategy || 'insert'} onChange={(e) => patchTable(tableIndex, { conflictStrategy: e.target.value })}><option value="insert">insert</option><option value="upsert">upsert</option><option value="truncate-load">truncate-load</option></select></div>
                  <div className="field"><div className="field-label">Chunk size</div><input type="number" value={mapping.chunkSize || 500} onChange={(e) => patchTable(tableIndex, { chunkSize: Number(e.target.value || 500) })} /></div>
                  <div className="field full"><div className="field-label">Conflict keys</div><input value={(mapping.conflictKeys || []).join(',')} onChange={(e) => patchTable(tableIndex, { conflictKeys: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="id,external_id" /></div>
                  <label className="check full" style={{ gridColumn: 'span 12' }}>
                    <input type="checkbox" checked={mapping.rowFilter?.enabled === true} onChange={(e) => patchRowFilter(tableIndex, { enabled: e.target.checked })} />
                    <span className="field-label" style={{ margin: 0 }}>Enable row filter</span>
                  </label>
                  <div className="field full"><div className="field-label">Row filter expression</div><input value={mapping.rowFilter?.expression || ''} onChange={(e) => patchRowFilter(tableIndex, { expression: e.target.value })} placeholder="row.status !== 'deleted'" disabled={mapping.rowFilter?.enabled !== true} /></div>
                  <div className="field full"><div className="field-label">Operational notes</div><div className="hint">{mappingRiskSummary(mapping).join(' • ') || 'No special notes.'}</div></div>
                  <label className="check full" style={{ gridColumn: 'span 12' }}>
                    <input type="checkbox" checked={mapping.createTargetTable === true} onChange={(e) => patchTable(tableIndex, { createTargetTable: e.target.checked, targetTableMode: e.target.checked ? 'create_new' : 'existing' })} />
                    <span className="field-label" style={{ margin: 0 }}>Create target table if it does not exist</span>
                  </label>
                </div>

                <div style={{ height: 12 }} />
                <div className="schema-table-scroll">
                  <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Use</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Source column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Target column</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Transform</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>State</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mapping.columnMappings || []).map((column, colIndex) => (
                        <tr key={column.id}>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><input type="checkbox" checked={column.enabled !== false} onChange={(e) => patchColumn(tableIndex, colIndex, { enabled: e.target.checked })} /></td>
                          <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.sourceColumn}</td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><input value={column.targetColumn || ''} onChange={(e) => patchColumn(tableIndex, colIndex, { targetColumn: e.target.value || null })} placeholder="target column" /></td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                            <select value={column.transform?.preset || column.transform?.type || 'direct'} onChange={(e) => {
                              const selected = e.target.value;
                              const preset = transformCatalog.find((item) => item.name === selected);
                              patchColumn(tableIndex, colIndex, { transform: preset ? { preset: selected, ...(preset.rule || {}) } : { ...(column.transform || {}), type: selected, config: column.transform?.config || {} } });
                            }}>
                              <option value="direct">direct</option>
                              <option value="string">string</option>
                              <option value="number">number</option>
                              <option value="boolean">boolean</option>
                              <option value="json">json</option>
                              <option value="date">date</option>
                              <option value="datetime">datetime</option>
                              <option value="constant">constant</option>
                              <option value="null">null</option>
                              <option value="template">template</option>
                              <option value="lookup">lookup</option>
                              <option value="expression">expression</option>
                              <option value="concat">concat</option>
                              <option value="coalesce">coalesce</option>
                              {transformCatalog.map((item) => <option key={item.name} value={item.name}>preset:{item.name}</option>)}
                            </select>
                            <div className="hint" style={{ marginTop: 6 }}>{transformCatalog.find((item) => item.name === (column.transform?.preset || ''))?.description || 'Configure transform behavior below when needed.'}</div>
                            {['template', 'expression', 'conditional'].includes(column.transform?.type || '') || column.transform?.preset ? (
                              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <input value={column.transform?.config?.template || column.transform?.config?.expression || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, column.transform?.type === 'template' ? 'template' : 'expression', e.target.value)} placeholder={column.transform?.type === 'template' ? '{{first_name}} {{last_name}}' : 'value != null ? value : null'} />
                                <input value={column.transform?.config?.when || ''} onChange={(e) => patchTransformConfig(tableIndex, colIndex, 'when', e.target.value)} placeholder="Optional condition: row.status === 'active'" />
                              </div>
                            ) : null}
                          </td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{badgeForColumnState(column.columnState || column.state)}</td>
                          <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{column.confidence ?? 'n/a'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(item.missingColumns || []).map((col) => col.name).join(', ') || '—'}</td>
                        <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(item.issues || []).map((issue) => issue.kind).join(', ') || '—'}</td>
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

function ValidateRunScreen() {
  const { currentProject, currentRun, preflightReport, setPreflightReport, dryRunPreview, setDryRunPreview, runReport, cutoverReport, setCutoverReport, selectedProjectId, selectedRunId, setSelectedRunId, runs, loadRun, loadRunReport, refreshRuns, streamRun, logs, setLogs, withBusy, busy, setMessage } = useApp();
  const [runErrors, setRunErrors] = useState([]);
  const [replayPlan, setReplayPlan] = useState(null);
  const [replayImportJson, setReplayImportJson] = useState('');
  const [replays, setReplays] = useState([]);
  const [verification, setVerification] = useState(null);
  const [executeOptions, setExecuteOptions] = useState({ mode: 'all', selectedTables: '', dryRun: false, errorPolicy: 'fail-fast', concurrency: 1, batchSize: 1000, cdcMode: 'off', cutoverMode: 'manual', watermarkColumn: '', verificationFingerprint: '' });
  const hasVerificationBlockers = Boolean(verification && !verification.readyToLoad);
  const watermarkInvalid = executeOptions.cdcMode === 'watermark' && !String(executeOptions.watermarkColumn || '').trim();
  const canExecute = Boolean(verification?.readyToLoad) && !watermarkInvalid;

  function readinessBadge(level) {
    if (level === 'ready') return 'Ready';
    if (level === 'review') return 'Review';
    if (level === 'provision') return 'Provision';
    if (level === 'blocked') return 'Blocked';
    return 'Unknown';
  }

  async function runPreflight() {
    if (!selectedProjectId) return;
    await withBusy('preflight', async () => {
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/preflight`, { method: 'POST', body: { sourceConnection: currentProject?.sourceConnection }, timeoutMs: 120000 });
      setPreflightReport(resp.report || null);
      setMessage('Preflight analysis completed');
    });
  }

  async function runDryRun() {
    if (!selectedProjectId) return;
    await withBusy('dry-run', async () => {
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/dry-run`, { method: 'POST', body: { sourceConnection: currentProject?.sourceConnection }, timeoutMs: 120000 });
      setDryRunPreview(resp.preview || null);
      setMessage('Dry run preview generated');
    });
  }

  async function verifyProject() {
    if (!selectedProjectId) return;
    await withBusy('verify', async () => {
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/verify`, { method: 'POST', body: { sourceConnection: currentProject?.sourceConnection }, timeoutMs: 120000 });
      setVerification(resp.verification || null);
      setExecuteOptions((curr) => ({ ...curr, verificationFingerprint: resp.verification?.verificationFingerprint || '' }));
      setMessage(resp.verification?.readyToLoad ? 'Verification passed — ready to load' : 'Verification completed with issues to review');
    });
  }

  async function loadCutoverReadiness(runId) {
    if (!runId) return;
    const resp = await api(`/runs/${encodeURIComponent(runId)}/cutover-readiness`);
    setCutoverReport(resp.cutover || null);
  }

  function verificationSummary() {
    const report = verification?.report;
    if (!report) return null;
    const blockerCount = report.summary?.blockerCount || 0;
    const warningCount = report.summary?.warningCount || 0;
    return {
      blockerCount,
      warningCount,
      readiness: verification.readyToLoad ? 'verified' : (blockerCount ? 'needs_manual_review' : 'verified_with_warnings'),
    };
  }

  const verificationMeta = verificationSummary();

  async function execute() {
    if (!selectedProjectId) return;
    await withBusy('execute', async () => {
      setLogs([]);
      const resp = await api(`/projects/${encodeURIComponent(selectedProjectId)}/execute`, {
        method: 'POST',
        body: {
          mode: executeOptions.mode,
          selectedTables: executeOptions.mode === 'selected' ? executeOptions.selectedTables.split(',').map((s) => s.trim()).filter(Boolean) : [],
          dryRun: executeOptions.dryRun,
          errorPolicy: executeOptions.errorPolicy,
          concurrency: Number(executeOptions.concurrency || 1),
          batchSize: Number(executeOptions.batchSize || 1000),
          cdcMode: executeOptions.cdcMode,
          cutoverMode: executeOptions.cutoverMode,
          watermarkColumn: executeOptions.watermarkColumn || undefined,
          verificationFingerprint: executeOptions.verificationFingerprint || undefined,
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
      await api(`/runs/${encodeURIComponent(selectedRunId)}/resume`, { method: 'POST', timeoutMs: 120000 });
      streamRun(selectedRunId);
      setMessage(`Resume scheduled for ${selectedRunId}`);
    });
  }

  async function rerunFailed() {
    if (!selectedRunId) return;
    await withBusy('rerun-failed', async () => {
      const resp = await api(`/runs/${encodeURIComponent(selectedRunId)}/rerun-failed`, { method: 'POST', timeoutMs: 120000 });
      setSelectedRunId(resp.runId || '');
      await refreshRuns();
      await loadRun(resp.runId);
      streamRun(resp.runId);
      setMessage(`Rerun started: ${resp.runId}`);
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
    const resp = await api(`/runs/${encodeURIComponent(selectedRunId)}/replay-import`, { method: 'POST', body: parsed, timeoutMs: 120000 });
    setReplayImportJson('');
    const replayHistory = await api(`/runs/${encodeURIComponent(selectedRunId)}/replays`).catch(() => ({ replays: [] }));
    setReplays(replayHistory.replays || []);
    setMessage(`Replay import completed: ${resp.replay?.summary?.replayed || 0} rows replayed`);
  }

  async function exportErrors() {
    if (!selectedRunId) return;
    const resp = await fetch(resolveApiUrl(`/runs/${encodeURIComponent(selectedRunId)}/errors/export`));
    const text = await resp.text();
    downloadText(`${selectedRunId}.errors.json`, text);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <SectionTitle title="Validation & execution" hint="Run safety checks, inspect transformed sample rows, then execute the migration with live progress." action={<span className="badge">Step 3</span>} />
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <button className="btn" type="button" onClick={() => void verifyProject()} disabled={!selectedProjectId || busy.verify}>{busy.verify ? 'Verifying…' : 'Verify project'}</button>
          <button className="btn" type="button" onClick={() => void runPreflight()} disabled={!selectedProjectId || busy.preflight}>{busy.preflight ? 'Running…' : 'Run preflight'}</button>
          <button className="btn" type="button" onClick={() => void runDryRun()} disabled={!selectedProjectId || busy['dry-run']}>{busy['dry-run'] ? 'Running…' : 'Build dry run'}</button>
          <button className="btn primary" type="button" onClick={() => void execute()} disabled={!selectedProjectId || busy.execute || !canExecute}>{busy.execute ? 'Starting…' : 'Execute migration'}</button>
        </div>

        {!canExecute ? <div className="alert warn" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Execution gated</div><div className="hint" style={{ marginTop: 6 }}>{watermarkInvalid ? 'Watermark mode requires a watermark column.' : 'Run verification first and resolve blockers before loading data.'}</div></div> : null}
        {executeOptions.cdcMode === 'watermark' ? <div className="alert warn" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Incremental mode warning</div><div className="hint" style={{ marginTop: 6 }}>Watermark mode is still groundwork. It does not provide full CDC semantics, delete capture, or robust cutover sync guarantees.</div></div> : null}

        <div className="form-grid">
          <div className="field"><div className="field-label">Run mode</div><select value={executeOptions.mode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, mode: e.target.value }))}><option value="all">all</option><option value="selected">selected</option></select></div>
          <div className="field"><div className="field-label">Error policy</div><select value={executeOptions.errorPolicy} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, errorPolicy: e.target.value }))}><option value="fail-fast">fail-fast</option><option value="quarantine">quarantine</option></select></div>
          <div className="field"><div className="field-label">Concurrency</div><input type="number" min="1" value={executeOptions.concurrency} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, concurrency: e.target.value }))} /></div>
          <div className="field"><div className="field-label">Batch size</div><input type="number" min="1" value={executeOptions.batchSize} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, batchSize: e.target.value }))} /></div>
          <div className="field"><div className="field-label">CDC mode</div><select value={executeOptions.cdcMode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, cdcMode: e.target.value }))}><option value="off">off</option><option value="snapshot-only">snapshot-only</option><option value="watermark">watermark</option></select></div>
          <div className="field"><div className="field-label">Cutover mode</div><select value={executeOptions.cutoverMode} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, cutoverMode: e.target.value }))}><option value="manual">manual</option><option value="guarded">guarded</option></select></div>
          <div className="field"><div className="field-label">Watermark column</div><input value={executeOptions.watermarkColumn} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, watermarkColumn: e.target.value }))} placeholder="updated_at" disabled={executeOptions.cdcMode !== 'watermark'} /></div>
          <div className="field full"><div className="field-label">Selected tables</div><input value={executeOptions.selectedTables} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, selectedTables: e.target.value }))} placeholder="users,orders" disabled={executeOptions.mode !== 'selected'} /></div>
          <label className="check full" style={{ gridColumn: 'span 12' }}>
            <input type="checkbox" checked={executeOptions.dryRun} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, dryRun: e.target.checked }))} />
            <span className="field-label" style={{ margin: 0 }}>Mark execution as dry run</span>
          </label>
          <div className="field full"><div className="field-label">Verification fingerprint</div><input value={executeOptions.verificationFingerprint} onChange={(e) => setExecuteOptions((curr) => ({ ...curr, verificationFingerprint: e.target.value }))} placeholder="Auto-filled after verification" /></div>
        </div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <SectionTitle title="Verification" hint="Readiness check for mapping completeness, target provisioning, and load safety." />
          {verificationMeta ? (
            <div className="toolbar" style={{ marginBottom: 12, gap: 8 }}>
              <TrustBadge level={verificationMeta.readiness} label={`Trust: ${verificationMeta.readiness}`} />
              <span className="badge">Blockers: {verificationMeta.blockerCount}</span>
              <span className="badge">Warnings: {verificationMeta.warningCount}</span>
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
                    <th style={{ textAlign: 'left', padding: 8 }}>Blockers</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Warnings</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Reasons</th>
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
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.blockerCount}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{item.warningCount}</td>
                      <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{(item.readiness?.reasons || []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {verification?.pendingSchemaActions?.length ? (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Pending schema actions</div>
              <div className="hint" style={{ marginTop: 6 }}>{verification.pendingSchemaActions.map((item) => `${item.action}:${item.targetTable}`).join(' • ')}</div>
            </div>
          ) : null}
          {verification?.blockingSchemaIssues?.length ? (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Blocking schema issues</div>
              <div className="hint" style={{ marginTop: 6 }}>{verification.blockingSchemaIssues.map((item) => `${item.action}:${item.targetTable}`).join(' • ')}</div>
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
        </div>
        <div className="card">
          <SectionTitle title="Preflight report" hint="Blockers and warnings based on table mappings and sample source rows." />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{preflightReport ? formatJson(preflightReport) : '—'}</div>
        </div>
        <div className="card">
          <SectionTitle title="Dry run preview" hint="Shows sample transformed rows using current column mappings." />
          <div className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{dryRunPreview ? formatJson(dryRunPreview) : '—'}</div>
        </div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <SectionTitle
            title="Runs"
            hint="Select a run to inspect current status or generate a final validation report."
            action={<div className="toolbar"><button className="btn" type="button" onClick={() => void resumeRun()} disabled={!selectedRunId || busy['resume-run']}>{busy['resume-run'] ? 'Scheduling…' : 'Resume'}</button><button className="btn" type="button" onClick={() => void rerunFailed()} disabled={!selectedRunId || busy['rerun-failed']}>{busy['rerun-failed'] ? 'Starting…' : 'Rerun failed'}</button></div>}
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
  const { projects, runs, loadProject, setSelectedProjectId, loadRun, setSelectedRunId, currentProject, currentRun, refreshProjects, refreshRuns, withBusy, busy, setMessage } = useApp();
  const [importJson, setImportJson] = useState('');

  async function exportProject(projectId) {
    await withBusy('export-project', async () => {
      const resp = await fetch(resolveApiUrl(`/projects/${encodeURIComponent(projectId)}/export`));
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
      await loadProject(resp.project?.id || '');
      setMessage(`Imported project ${resp.project?.id || ''}`.trim());
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <SectionTitle title="Projects" hint="Persisted project definitions, auto-mapping summaries, and export/import support." action={<button className="btn" type="button" onClick={() => void refreshProjects()}>Refresh</button>} />
          <div className="schema-table-scroll">
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Name</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Matched</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Updated</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <button className="btn" type="button" onClick={() => { setSelectedProjectId(project.id); void loadProject(project.id); }}>{project.name}</button>
                      <div className="hint mono" style={{ marginTop: 6 }}>{project.id}</div>
                    </td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{project.autoMappingSummary?.matchedTables || 0}/{project.autoMappingSummary?.sourceTables || 0}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{project.updatedAt || project.createdAt || '—'}</td>
                    <td style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}><button className="btn" type="button" onClick={() => void exportProject(project.id)} disabled={busy['export-project']}>Export</button></td>
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
    <div className="grid">
      <div className="card">
        <h3>How this tool works today</h3>
        <div className="hint">This UI now drives backend APIs for introspection, manual mapping, schema planning, target provisioning, verification, preview, execution, and report retrieval.</div>
        <ul style={{ marginTop: 12, paddingLeft: 20 }}>
          <li>Projects are persisted under <span className="mono">mysql-pg-migrate/state/projects</span>.</li>
          <li>Runs, reports, checkpoints, and errors are persisted under sibling state folders.</li>
          <li>Passwords remain only in browser memory/local form state and are not persisted by the UI.</li>
          <li>Wave-2 adds transform presets, richer run audit reporting, and error export workflows.</li>
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
  );
}

const TABS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'mapping', label: 'Mapping' },
  { id: 'validate-run', label: 'Validate & Run' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

function App() {
  const { tab, setTab, message, error, currentProject } = useApp();

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
            {currentProject ? <span className="badge">Project: {currentProject.name}</span> : null}
            <span className="badge">API: /api</span>
          </div>
        </div>

        <div className="panel-body">
          {message ? <div className="alert" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Info</div><div className="hint" style={{ marginTop: 6 }}>{message}</div></div> : null}
          {error ? <div className="alert warn" style={{ marginBottom: 14 }}><div style={{ fontWeight: 800 }}>Error</div><div className="hint" style={{ marginTop: 6 }}>{error}</div></div> : null}
          {tab === 'workspace' && <WorkspaceScreen />}
          {tab === 'mapping' && <MappingScreen />}
          {tab === 'validate-run' && <ValidateRunScreen />}
          {tab === 'history' && <HistoryScreen />}
          {tab === 'settings' && <SettingsScreen />}
        </div>
      </div>
    </div>
  );
}

setRuntime();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);