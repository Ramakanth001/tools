import React, { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/http.js';
import { openJobEventSource } from '../lib/sse.js';
import { useActiveConnection } from '../state/ActiveConnectionContext.jsx';
import { getLogsUrl, getPgBackupRuntime, getStorageKey, resolveApiUrl } from '../lib/runtime.js';

const LOCAL_DEFAULTS = {
  host: '127.0.0.1',
  port: 5432,
  user: '',
  database: '',
  password: '',
  sslmode: 'disable',
};

const REMOTE_DEFAULTS = {
  host: 'aws-1-ap-south-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.cughfeafhxhumjbijlpr',
  database: 'postgres',
  password: '',
  sslmode: 'require',
};

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

function buildPoolerConnectionString(pooler) {
  const host = String(pooler.host || '').trim();
  const port = Number(pooler.port || 5432);
  const user = String(pooler.user || '').trim();
  const database = String(pooler.database || '').trim();
  const password = String(pooler.password || '');
  const sslmode = String(pooler.sslmode || '').trim() || (host === '127.0.0.1' || host === 'localhost' ? 'disable' : 'require');
  if (!host || !user || !database) return '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=${encodeURIComponent(sslmode)}`;
}

function detectConnectionMode(connectionString) {
  return String(connectionString || '').trim() ? 'connectionString' : 'local';
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
  // Primary source: browser localStorage
  const local = loadProfiles();
  const localById = new Map(local.map((p) => [String(p.id), p]));

  // Fallback: a static file served from /public (useful after clearing site data)
  try {
    const resp = await api('/profiles-template');
    const fallback = Array.isArray(resp.profiles) ? resp.profiles : [];
    const merged = [...local];
    for (const item of fallback) {
      const id = String(item?.id || '');
      if (!id || localById.has(id)) continue;
      merged.push(item);
    }
    if (merged.length) {
      saveProfiles(merged);
      return merged;
    }
    return [];
  } catch {
    return local;
  }
}

function saveProfiles(profiles) {
  localStorage.setItem(getProfilesKey(), JSON.stringify(profiles));
}

function RequiredStar() {
  return <span style={{ color: '#f59e0b', marginLeft: 4 }}>*</span>;
}

function getConnectionSummary(mode, effectiveConnString) {
  if (!effectiveConnString) return 'No connection configured yet.';
  if (mode === 'local') return 'Using local PostgreSQL fields.';
  if (mode === 'remote') return 'Using remote/hosted PostgreSQL fields.';
  return 'Using full connection string.';
}

export default function RunScreen() {
  const { active, setActive } = useActiveConnection();
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [connectionMode, setConnectionMode] = useState(() => detectConnectionMode(active.connectionString || ''));
  const [showAdvancedProfiles, setShowAdvancedProfiles] = useState(false);

  // Load profiles on mount (localStorage, with fallback file)
  useEffect(() => {
    (async () => {
      const list = await loadProfilesWithFallback();
      setProfiles(list);
    })();
  }, []);

  const [connectionString, setConnectionString] = useState(active.connectionString || '');
  const [pooler, setPooler] = useState(active.pooler || LOCAL_DEFAULTS);

  // Keep shared active connection updated.
  useEffect(() => {
    setActive({ connectionString, pooler });
  }, [connectionString, pooler, setActive]);

  useEffect(() => {
    if (connectionMode === 'local') {
      setConnectionString('');
      setPooler((prev) => ({
        ...LOCAL_DEFAULTS,
        ...prev,
        host: prev.host && prev.host !== REMOTE_DEFAULTS.host ? prev.host : LOCAL_DEFAULTS.host,
        port: Number(prev.port || LOCAL_DEFAULTS.port),
        sslmode: 'disable',
      }));
      return;
    }

    if (connectionMode === 'remote') {
      setConnectionString('');
      setPooler((prev) => ({
        ...REMOTE_DEFAULTS,
        ...prev,
        sslmode: prev.sslmode || 'require',
      }));
    }
  }, [connectionMode]);

  const [options, setOptions] = useState({
    fullDump: true,
    schemaOnly: true,
    inventory: true,
    plainSql: false,
    roles: true,
    schemaInclude: '',
    schemaExclude: '',
    tableInclude: '',
    tableExclude: '',
  });

  const [testStatus, setTestStatus] = useState('—');
  const [jobId, setJobId] = useState('—');
  const [runStatus, setRunStatus] = useState('Idle');
  const [progress, setProgress] = useState({ percent: 0, phase: '—', bytes: 0 });
  const [logs, setLogs] = useState('');
  const [error, setError] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [running, setRunning] = useState(false);

  const effectiveConnString = useMemo(() => {
    return connectionMode === 'connectionString' ? connectionString.trim() : buildPoolerConnectionString(pooler);
  }, [connectionMode, connectionString, pooler]);

  const [ev, setEv] = useState(null);

  useEffect(() => {
    return () => {
      try {
        ev?.close();
      } catch {
        // ignore
      }
    };
  }, [ev]);

  function applyProfile(p) {
    if (!p) return;
    const nextMode = p.connectionString ? 'connectionString' : 'local';
    setConnectionMode(nextMode);
    setConnectionString(p.connectionString || '');
    setPooler((prev) => ({
      ...prev,
      host: p.host || prev.host,
      port: Number(p.port || prev.port || 5432),
      user: p.user || prev.user,
      database: p.database || prev.database,
      sslmode: p.sslmode || prev.sslmode || (nextMode === 'local' ? 'disable' : 'require'),
      // never store password
      password: '',
    }));
  }

  function onSelectProfile(id) {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    applyProfile(p);
  }

  function saveProfile() {
    const name = profileName.trim();
    if (!name) {
      setError('Missing profile name');
      return;
    }
    const item = {
      id: `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`,
      name,
      host: pooler.host,
      port: Number(pooler.port || 5432),
      user: pooler.user,
      database: pooler.database,
      sslmode: pooler.sslmode,
      connectionString: connectionMode === 'connectionString' ? connectionString.trim() : '',
      createdAt: new Date().toISOString(),
    };
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

  const [profilesJson, setProfilesJson] = useState('');

  function exportProfilesJsonToTextarea() {
    setProfilesJson(JSON.stringify(profiles, null, 2));
  }

  function downloadProfilesJson() {
    const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getPgBackupRuntime().toolId}.profiles.json`;
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

      // Normalize and ensure we never store password.
      const next = parsed
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          id: String(p.id || `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`),
          name: String(p.name || 'Unnamed profile'),
          host: p.host ? String(p.host) : '',
          port: p.port != null ? Number(p.port) : 5432,
          user: p.user ? String(p.user) : '',
          database: p.database ? String(p.database) : '',
          sslmode: p.sslmode ? String(p.sslmode) : '',
          connectionString: p.connectionString ? String(p.connectionString) : '',
          createdAt: p.createdAt ? String(p.createdAt) : new Date().toISOString(),
        }))
        .slice(0, 50);

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
      const text = await file.text();
      setProfilesJson(text);
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function testConnection() {
    setError('');
    setTestStatus('Testing…');
    try {
      if (!effectiveConnString) throw new Error('Missing connection details');
      await api('/test-connection', { method: 'POST', body: { connectionString: effectiveConnString }, timeoutMs: 30_000 });
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
      const body = {
        connectionString: connectionMode === 'connectionString' ? connectionString.trim() || undefined : undefined,
        pooler: connectionMode === 'connectionString' ? undefined : pooler,
        options,
      };

      const resp = await api('/backup', { method: 'POST', body, timeoutMs: 60_000 });
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
            setDownloadUrl(resolveApiUrl(`/jobs/${encodeURIComponent(resp.jobId)}/download`));
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
      await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', timeoutMs: 10_000 });
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  const modeHelp =
    connectionMode === 'local'
      ? 'Best for PostgreSQL running on your machine. Usually only the local fields below are needed and SSL should stay disabled.'
      : connectionMode === 'remote'
        ? 'Best for cloud / hosted PostgreSQL. SSL is usually required.'
        : 'Use this only if you already have a full PostgreSQL connection string.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <h3>Connection</h3>
        <div className="hint">Choose one connection mode. The form will only use the fields for that mode. Password is never stored.</div>

        <div style={{ height: 10 }} />

        <div className="field full">
          <div className="field-label">Connection type</div>
          <select value={connectionMode} onChange={(e) => setConnectionMode(e.target.value)}>
            <option value="local">Local PostgreSQL</option>
            <option value="remote">Remote PostgreSQL / Supabase</option>
            <option value="connectionString">Full connection string</option>
          </select>
          <div className="field-hint">{modeHelp}</div>
        </div>

        <div style={{ height: 10 }} />

        <div className="form-grid">
          <div className="field full">
            <div className="field-label">Saved profile</div>
            <div className="toolbar" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <select value={profileId} onChange={(e) => onSelectProfile(e.target.value)}>
                  <option value="">— Select profile —</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="field-hint">Stored in your browser. Password is never stored.</div>
              </div>
              <button className="btn danger" type="button" onClick={deleteProfile} disabled={!profileId}>
                Delete
              </button>
            </div>
          </div>

          <div className="field">
            <div className="field-label">Save current setup as profile</div>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="e.g. local-dev" />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <div className="field-label" style={{ opacity: 0 }}>.</div>
            <button className="btn" type="button" onClick={saveProfile}>
              Save profile
            </button>
          </div>
        </div>

        <div style={{ height: 10 }} />

        {connectionMode === 'connectionString' ? (
          <div className="field full">
            <div className="field-label">Full connection string<RequiredStar /></div>
            <textarea
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder="postgresql://shop_pg_user:password@127.0.0.1:5432/shop_pg?sslmode=disable"
            />
            <div className="field-hint">For local PostgreSQL, include <span className="mono">sslmode=disable</span>. If you provide <span className="mono">sslmode</span>, the backend will respect it.</div>
          </div>
        ) : (
          <>
            <div className="alert" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>{connectionMode === 'local' ? 'Recommended local setup' : 'Remote setup'}</div>
              <div className="hint" style={{ marginTop: 6 }}>
                {connectionMode === 'local'
                  ? 'Example: Host 127.0.0.1, Port 5432, User shop_pg_user, Database shop_pg, SSL disable.'
                  : 'Example: your hosted PostgreSQL details or Supabase pooler values, usually with SSL require.'}
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <div className="field-label">Host<RequiredStar /></div>
                <input value={pooler.host} onChange={(e) => setPooler((p) => ({ ...p, host: e.target.value }))} placeholder={connectionMode === 'local' ? '127.0.0.1' : 'db.example.com'} />
              </div>
              <div className="field">
                <div className="field-label">Port<RequiredStar /></div>
                <input type="number" value={pooler.port} onChange={(e) => setPooler((p) => ({ ...p, port: Number(e.target.value || 5432) }))} placeholder="5432" />
              </div>
              <div className="field">
                <div className="field-label">User<RequiredStar /></div>
                <input value={pooler.user} onChange={(e) => setPooler((p) => ({ ...p, user: e.target.value }))} placeholder={connectionMode === 'local' ? 'shop_pg_user' : 'postgres.project-ref'} />
              </div>
              <div className="field">
                <div className="field-label">Database<RequiredStar /></div>
                <input value={pooler.database} onChange={(e) => setPooler((p) => ({ ...p, database: e.target.value }))} placeholder={connectionMode === 'local' ? 'shop_pg' : 'postgres'} />
              </div>
              <div className="field">
                <div className="field-label">SSL mode</div>
                <select value={pooler.sslmode || (connectionMode === 'local' ? 'disable' : 'require')} onChange={(e) => setPooler((p) => ({ ...p, sslmode: e.target.value }))}>
                  <option value="disable">disable</option>
                  <option value="require">require</option>
                </select>
                <div className="field-hint">Use <span className="mono">disable</span> for most local PostgreSQL installs.</div>
              </div>
              <div className="field full">
                <div className="field-label">Password<RequiredStar /></div>
                <input type="password" value={pooler.password} onChange={(e) => setPooler((p) => ({ ...p, password: e.target.value }))} placeholder="Enter database password" />
                <div className="field-hint">Password is used for this session only and is never stored in profiles.</div>
              </div>
            </div>
          </>
        )}

        <div style={{ height: 12 }} />
        <div className="alert" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 800 }}>What this screen will use</div>
          <div className="hint" style={{ marginTop: 6 }}>{getConnectionSummary(connectionMode, effectiveConnString)}</div>
          <div className="mono" style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{effectiveConnString || '—'}</div>
        </div>

        <div style={{ height: 12 }} />
        <div className="toolbar">
          <button className="btn" onClick={testConnection} disabled={running}>
            Test connection
          </button>
          <span className="badge">{testStatus}</span>
        </div>
      </div>

      <div className="card">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Advanced: profiles JSON</h3>
          <button className="btn" type="button" onClick={() => setShowAdvancedProfiles((v) => !v)}>
            {showAdvancedProfiles ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="hint">Only use this if you want to export/import saved profiles. Beginners can ignore this section.</div>

        {showAdvancedProfiles ? (
          <>
            <div style={{ height: 10 }} />
            <div className="toolbar">
              <button className="btn" type="button" onClick={exportProfilesJsonToTextarea}>
                Export to text
              </button>
              <button className="btn" type="button" onClick={downloadProfilesJson}>
                Download JSON
              </button>
              <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
                Upload JSON
                <input
                  type="file"
                  accept="application/json"
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importProfilesFromFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button className="btn primary" type="button" onClick={importProfilesFromJsonText}>
                Import (apply)
              </button>
            </div>

            <div style={{ height: 10 }} />
            <textarea
              value={profilesJson}
              onChange={(e) => setProfilesJson(e.target.value)}
              placeholder="Paste profiles JSON array here…"
              style={{ minHeight: 180 }}
            />
            <div className="field-hint" style={{ marginTop: 8 }}>
              Stored key: <span className="mono">{getProfilesKey()}</span> • Max 50 profiles.
            </div>
          </>
        ) : null}
      </div>

      <div className="card">
        <h3>Backup options</h3>
        <div className="form-grid">
          {(
            [
              ['fullDump', 'Full dump (custom)'],
              ['schemaOnly', 'Schema-only'],
              ['inventory', 'Inventory'],
              ['plainSql', 'Plain SQL dump'],
              ['roles', 'Roles/privileges'],
            ]
          ).map(([k, label]) => (
            <label key={k} className="check" style={{ gridColumn: 'span 6' }}>
              <input type="checkbox" checked={Boolean(options[k])} onChange={(e) => setOptions((o) => ({ ...o, [k]: e.target.checked }))} />
              <span className="field-label" style={{ margin: 0 }}>{label}</span>
            </label>
          ))}
        </div>

        <div style={{ height: 10 }} />
        <div className="toolbar">
          <button className="btn primary" onClick={runBackup} disabled={running}>
            Run backup
          </button>
          <button className="btn danger" onClick={cancel} disabled={!running}>
            Cancel
          </button>
          {downloadUrl ? (
            <a className="btn" href={downloadUrl}>
              Download zip
            </a>
          ) : null}
          <span className="badge">Job: <span className="mono">{jobId}</span></span>
          <span className="badge">Status: {runStatus}</span>
        </div>

        <div style={{ height: 10 }} />
        <div className="hint">Progress: {progress.phase} • {progress.percent}%{progress.bytes ? ` • ${formatBytes(progress.bytes)}` : ''}</div>
        <div style={{ height: 8 }} />
        <progress max="100" value={progress.percent || 0} style={{ width: '100%', height: 12 }} />

        {error ? (
          <div className="alert warn" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800 }}>Error</div>
            <div className="hint" style={{ marginTop: 6 }}>{error}</div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Logs</h3>
          <div className="toolbar">
            <button
              className="btn"
              type="button"
              onClick={() => window.open(getLogsUrl(jobId || ''), '_blank', 'noopener,noreferrer')}
              disabled={!jobId || jobId === '—'}
            >
              Open in new window
            </button>
          </div>
        </div>
        <div className="mono" style={{ whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 12, height: 280, overflow: 'auto' }}>
          {logs || '—'}
        </div>
      </div>
    </div>
  );
}
