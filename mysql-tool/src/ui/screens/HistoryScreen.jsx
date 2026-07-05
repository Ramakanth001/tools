import React, { useEffect, useState } from 'react';

import { api, withAuthQuery } from '../lib/http.js';
import { resolveApiUrl } from '../lib/runtime.js';

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

export default function HistoryScreen() {
  const [q, setQ] = useState('');
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);
  const [keep, setKeep] = useState(200);

  async function refresh() {
    setError('');
    try {
      const data = await api(`/jobs?limit=50&q=${encodeURIComponent(q)}`);
      setJobs(data.jobs || []);
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function del(id) {
    if (!confirm(`Delete job ${id}? This removes the folder + zip.`)) return;
    try {
      await api(`/jobs/${encodeURIComponent(id)}/delete`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function cleanup() {
    setError('');
    try {
      await api('/cleanup', { method: 'POST', body: { days, keep } });
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <div className="toolbar">
          <div className="field" style={{ gridColumn: 'span 6', minWidth: 260 }}>
            <div className="field-label">Search</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search job id…" />
          </div>
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      <div style={{ height: 12 }} />

      <div className="toolbar">
        <span className="badge">Retention</span>
        <div className="field" style={{ maxWidth: 160 }}>
          <div className="field-label">Days</div>
          <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value || 30))} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <div className="field-label">Keep</div>
          <input type="number" value={keep} onChange={(e) => setKeep(Number(e.target.value || 200))} />
        </div>
        <button className="btn danger" onClick={cleanup}>
          Cleanup
        </button>
      </div>

      {error ? (
        <div className="alert warn" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800 }}>Error</div>
          <div className="hint" style={{ marginTop: 6 }}>{error}</div>
        </div>
      ) : null}

      <div style={{ height: 12 }} />

      <div style={{ overflow: 'auto' }}>
        <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 10, color: 'rgba(238,242,255,0.65)' }}>Job ID</th>
              <th style={{ textAlign: 'left', padding: 10, color: 'rgba(238,242,255,0.65)' }}>Status</th>
              <th style={{ textAlign: 'left', padding: 10, color: 'rgba(238,242,255,0.65)' }}>Created</th>
              <th style={{ textAlign: 'right', padding: 10, color: 'rgba(238,242,255,0.65)' }}>Zip size</th>
              <th style={{ textAlign: 'right', padding: 10, color: 'rgba(238,242,255,0.65)' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="mono" style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{j.id}</td>
                <td style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{j.status}</td>
                <td style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>{new Date(j.createdAt).toLocaleString()}</td>
                <td style={{ padding: 10, textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.06)' }}>{j.zipBytes != null ? formatBytes(j.zipBytes) : '—'}</td>
                <td style={{ padding: 10, textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
                    <a className="tab" style={{ border: '1px solid rgba(255,255,255,0.12)' }} href={withAuthQuery(resolveApiUrl(`/jobs/${encodeURIComponent(j.id)}/download`))}>
                      Download
                    </a>
                    <button className="btn danger" onClick={() => del(j.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
