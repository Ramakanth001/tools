import React, { useEffect, useMemo, useState } from 'react';

import { api, withAuthQuery } from '../lib/http.js';
import { openJobEventSource } from '../lib/sse.js';
import { useActiveConnection } from '../state/ActiveConnectionContext.jsx';
import { getLogsUrl, getMysqlToolRuntime, getStorageKey, resolveApiUrl } from '../lib/runtime.js';

function nowISO() {
  return new Date().toISOString();
}

function formatBytes(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let v = num;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(v < 10 && idx > 0 ? 2 : 1)} ${units[idx]}`;
}

function getProfilesKey() {
  return getStorageKey('profiles');
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(getProfilesKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadProfilesWithFallback() {
  const local = loadProfiles();
  if (local.length) return local;
  try {
    const resp = await api('/profiles-template');
    const list = Array.isArray(resp.profiles) ? resp.profiles : [];
    if (list.length) saveProfiles(list);
    return list;
  } catch {
    return [];
  }
}

function saveProfiles(profiles) {
  localStorage.setItem(getProfilesKey(), JSON.stringify(profiles));
}

const DEFAULT_CONNECTION = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', sslMode: 'PREFERRED', sslCa: '', sslCert: '', sslKey: '', connectionString: '' };

export default function RunScreen() {
  const { active, setActive } = useActiveConnection();
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profilesJson, setProfilesJson] = useState('');
  const [connection, setConnection] = useState(
    active.connection || DEFAULT_CONNECTION
  );

  useEffect(() => {
    void loadProfilesWithFallback().then(setProfiles);
  }, []);

  useEffect(() => {
    setActive({ connection });
  }, [connection, setActive]);

  const [options, setOptions] = useState({ fullDump: true, schemaOnly: true, inventory: true, tableInclude: '', tableExclude: '' });
  const [testStatus, setTestStatus] = useState('—');
  const [jobId, setJobId] = useState('—');
  const [runStatus, setRunStatus] = useState('Idle');
  const [progress, setProgress] = useState({ percent: 0, phase: '—', bytes: 0 });
  const [logs, setLogs] = useState('');
  const [error, setError] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [ev, setEv] = useState(null);

  const effectiveConnection = useMemo(() => ({ ...connection, port: Number(connection.port || 3306) }), [connection]);

  useEffect(() => () => {
    try {
      ev?.close();
    } catch {
      // ignore
    }
  }, [ev]);

  function applyProfile(p) {
    if (!p) return;
    setConnection((prev) => ({ ...prev, host: p.host || prev.host, port: Number(p.port || prev.port || 3306), user: p.user || prev.user, database: p.database || prev.database, sslMode: p.sslMode || prev.sslMode || 'PREFERRED', sslCa: p.sslCa || '', sslCert: p.sslCert || '', sslKey: '', connectionString: p.connectionString || '', password: '' }));
  }

  function onSelectProfile(id) {
    setProfileId(id);
    applyProfile(profiles.find((x) => x.id === id));
  }

  function saveProfile() {
    const name = profileName.trim();
    if (!name) {
      setError('Missing profile name');
      return;
    }
    const item = { id: `m_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`, name, host: connection.host, port: Number(connection.port || 3306), user: connection.user, database: connection.database, sslMode: connection.sslMode, sslCa: connection.sslCa || '', sslCert: connection.sslCert || '', connectionString: connection.connectionString.trim(), createdAt: new Date().toISOString() };
    const next = [item, ...profiles].slice(0, 50);
    setProfiles(next);
    saveProfiles(next);
    setProfileName('');
    setProfileId(item.id);
  }

  function deleteProfile() {
    if (!profileId) return;
    const next = profiles.filter((p) => p.id !== profileId);
    setProfiles(next);
    saveProfiles(next);
    setProfileId('');
  }

  function exportProfilesJsonToTextarea() {
    setProfilesJson(JSON.stringify(profiles, null, 2));
  }

  function downloadProfilesJson() {
    const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getMysqlToolRuntime().toolId}.profiles.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importProfilesFromJsonText() {
    setError('');
    try {
      const parsed = JSON.parse(profilesJson || '[]');
      if (!Array.isArray(parsed)) throw new Error('Profiles JSON must be an array');
      const next = parsed.filter((p) => p && typeof p === 'object').map((p) => ({ id: String(p.id || `m_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`), name: String(p.name || 'Unnamed profile'), host: p.host ? String(p.host) : '127.0.0.1', port: p.port != null ? Number(p.port) : 3306, user: p.user ? String(p.user) : 'root', database: p.database ? String(p.database) : '', sslMode: p.sslMode ? String(p.sslMode) : 'PREFERRED', sslCa: p.sslCa ? String(p.sslCa) : '', sslCert: p.sslCert ? String(p.sslCert) : '', connectionString: p.connectionString ? String(p.connectionString) : '', createdAt: p.createdAt ? String(p.createdAt) : new Date().toISOString() })).slice(0, 50);
      setProfiles(next);
      saveProfiles(next);
      setProfileId('');
      setProfileName('');
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function importProfilesFromFile(file) {
    setError('');
    try {
      setProfilesJson(await file.text());
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function testConnection() {
    setError('');
    setTestStatus('Testing…');
    try {
      await api('/test-connection', { method: 'POST', body: { connection: effectiveConnection }, timeoutMs: 30000 });
      setTestStatus('OK');
    } catch (e) {
      setTestStatus('FAILED');
      setError(e?.message || String(e));
    }
  }

  async function runBackup() {
    setError('');
    setLogs('');
    setDownloadUrl('');
    setRunStatus('Starting…');
    setProgress({ percent: 0, phase: 'starting', bytes: 0 });
    setRunning(true);
    try {
      const resp = await api('/backup', { method: 'POST', body: { connection: effectiveConnection, options }, timeoutMs: 60000 });
      setJobId(resp.jobId);
      const nextEv = openJobEventSource(resp.jobId, {
        onLog: (line) => setLogs((s) => (s ? `${s}\n${line}` : String(line))),
        onProgress: (p) => {
          setProgress({ percent: p.percent || 0, phase: p.phase || 'running', bytes: p.bytes || 0 });
          setRunStatus(typeof p.percent === 'number' ? `${Math.max(0, Math.min(100, p.percent))}%` : 'Running…');
        },
        onStatus: (s) => {
          try {
            nextEv.close();
          } catch {
            // ignore
          }
          setRunning(false);
          if (s.status === 'done') {
            setRunStatus('Done');
            setProgress((p) => ({ ...p, percent: 100, phase: 'done' }));
            setDownloadUrl(withAuthQuery(resolveApiUrl(`/jobs/${encodeURIComponent(resp.jobId)}/download`)));
          } else if (s.status === 'cancelled') {
            setRunStatus('Cancelled');
          } else {
            setRunStatus('Error');
          }
        },
      });
      setEv(nextEv);
      setLogs((s) => (s ? `${s}\n[${nowISO()}] Job created: ${resp.jobId}` : `[${nowISO()}] Job created: ${resp.jobId}`));
    } catch (e) {
      setRunning(false);
      setRunStatus('Error');
      setError(e?.message || String(e));
    }
  }

  async function cancel() {
    if (!jobId || jobId === '—') return;
    try {
      await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', timeoutMs: 10000 });
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <h3>Connection</h3>
        <div className="hint">Fill in your MySQL database details. Password is never stored.</div>
        <div style={{ height: 10 }} />
        <div className="form-grid">
          <div className="field full">
            <div className="field-label">Profile</div>
            <div className="toolbar" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <select value={profileId} onChange={(e) => onSelectProfile(e.target.value)}>
                  <option value="">— Select profile —</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div className="field-hint">Stored in your browser. Password is never stored.</div>
              </div>
              <button className="btn danger" type="button" onClick={deleteProfile} disabled={!profileId}>Delete</button>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Save as profile</div>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="e.g. prod-mysql" />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <div className="field-label" style={{ opacity: 0 }}>.</div>
            <button className="btn" type="button" onClick={saveProfile}>Save profile</button>
          </div>
        </div>
        <div style={{ height: 10 }} />
        <div className="field full">
          <div className="field-label">Connection string</div>
          <input value={connection.connectionString} onChange={(e) => setConnection((p) => ({ ...p, connectionString: e.target.value }))} placeholder="mysql://user:pass@host:3306/db" />
          <div className="field-hint">Optional mysql:// URL. Values from the URL fill any missing fields below at runtime.</div>
        </div>
        <div style={{ height: 10 }} />
        <div className="form-grid">
          <div className="field"><div className="field-label">Host</div><input value={connection.host} onChange={(e) => setConnection((p) => ({ ...p, host: e.target.value }))} /></div>
          <div className="field"><div className="field-label">Port</div><input type="number" value={connection.port} onChange={(e) => setConnection((p) => ({ ...p, port: Number(e.target.value || 3306) }))} /></div>
          <div className="field"><div className="field-label">User</div><input value={connection.user} onChange={(e) => setConnection((p) => ({ ...p, user: e.target.value }))} /></div>
          <div className="field"><div className="field-label">Database</div><input value={connection.database} onChange={(e) => setConnection((p) => ({ ...p, database: e.target.value }))} /></div>
          <div className="field"><div className="field-label">SSL mode</div><select value={connection.sslMode} onChange={(e) => setConnection((p) => ({ ...p, sslMode: e.target.value }))}><option value="PREFERRED">PREFERRED</option><option value="REQUIRED">REQUIRED</option><option value="DISABLED">DISABLED</option><option value="VERIFY_CA">VERIFY_CA</option><option value="VERIFY_IDENTITY">VERIFY_IDENTITY</option></select></div>
          <div className="field full"><div className="field-label">Password</div><input type="password" value={connection.password} onChange={(e) => setConnection((p) => ({ ...p, password: e.target.value }))} /></div>
          <div className="field"><div className="field-label">SSL CA path</div><input value={connection.sslCa || ''} onChange={(e) => setConnection((p) => ({ ...p, sslCa: e.target.value }))} placeholder="/path/to/ca.pem" /></div>
          <div className="field"><div className="field-label">SSL cert path</div><input value={connection.sslCert || ''} onChange={(e) => setConnection((p) => ({ ...p, sslCert: e.target.value }))} placeholder="/path/to/client-cert.pem" /></div>
          <div className="field"><div className="field-label">SSL key path</div><input type="password" value={connection.sslKey || ''} onChange={(e) => setConnection((p) => ({ ...p, sslKey: e.target.value }))} placeholder="/path/to/client-key.pem" /></div>
        </div>
        <div style={{ height: 12 }} />
        <div className="toolbar"><button className="btn" onClick={testConnection} disabled={running}>Test connection</button><span className="badge">{testStatus}</span></div>
      </div>

      <div className="card">
        <h3>Profiles JSON</h3>
        <div className="hint">Export/import profiles as JSON. Password is never stored in profiles.</div>
        <div style={{ height: 10 }} />
        <div className="toolbar">
          <button className="btn" type="button" onClick={exportProfilesJsonToTextarea}>Export to text</button>
          <button className="btn" type="button" onClick={downloadProfilesJson}>Download JSON</button>
          <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
            Upload JSON
            <input type="file" accept="application/json" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProfilesFromFile(f); e.target.value = ''; }} />
          </label>
          <button className="btn primary" type="button" onClick={importProfilesFromJsonText}>Import (apply)</button>
        </div>
        <div style={{ height: 10 }} />
        <textarea value={profilesJson} onChange={(e) => setProfilesJson(e.target.value)} placeholder="Paste profiles JSON array here…" style={{ minHeight: 180 }} />
        <div className="field-hint" style={{ marginTop: 8 }}>Stored key: <span className="mono">{getProfilesKey()}</span> • Max 50 profiles.</div>
      </div>

      <div className="card">
        <h3>Backup options</h3>
        <div className="form-grid">
          {[['fullDump', 'Full SQL dump'], ['schemaOnly', 'Schema-only dump'], ['inventory', 'Inventory exports']].map(([k, label]) => (
            <label key={k} className="check" style={{ gridColumn: 'span 6' }}>
              <input type="checkbox" checked={Boolean(options[k])} onChange={(e) => setOptions((o) => ({ ...o, [k]: e.target.checked }))} />
              <span className="field-label" style={{ margin: 0 }}>{label}</span>
            </label>
          ))}
          <div className="field full"><div className="field-label">Table include</div><input value={options.tableInclude} onChange={(e) => setOptions((o) => ({ ...o, tableInclude: e.target.value }))} placeholder="users,orders" /></div>
          <div className="field full"><div className="field-label">Table exclude</div><input value={options.tableExclude} onChange={(e) => setOptions((o) => ({ ...o, tableExclude: e.target.value }))} placeholder="audit_logs,temp_data" /></div>
        </div>
        <div style={{ height: 10 }} />
        <div className="toolbar">
          <button className="btn primary" onClick={runBackup} disabled={running}>Run backup</button>
          <button className="btn danger" onClick={cancel} disabled={!running}>Cancel</button>
          {downloadUrl ? <a className="btn" href={downloadUrl}>Download zip</a> : null}
          <span className="badge">Job: <span className="mono">{jobId}</span></span>
          <span className="badge">Status: {runStatus}</span>
        </div>
        <div style={{ height: 10 }} />
        <div className="hint">Progress: {progress.phase} • {progress.percent}%{progress.bytes ? ` • ${formatBytes(progress.bytes)}` : ''}</div>
        <div style={{ height: 8 }} />
        <progress max="100" value={progress.percent || 0} style={{ width: '100%', height: 12 }} />
        {error ? <div className="alert warn" style={{ marginTop: 12 }}><div style={{ fontWeight: 800 }}>Error</div><div className="hint" style={{ marginTop: 6 }}>{error}</div></div> : null}
      </div>

      <div className="card">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Logs</h3>
          <div className="toolbar"><button className="btn" type="button" onClick={() => window.open(getLogsUrl(jobId || ''), '_blank', 'noopener,noreferrer')} disabled={!jobId || jobId === '—'}>Open in new window</button></div>
        </div>
        <div className="mono" style={{ whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 12, height: 280, overflow: 'auto' }}>{logs || '—'}</div>
      </div>
    </div>
  );
}
