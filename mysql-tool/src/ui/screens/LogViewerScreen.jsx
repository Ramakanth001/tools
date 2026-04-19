import React, { useEffect, useMemo, useState } from 'react';

import { openJobEventSource } from '../lib/sse.js';
import { getHomeUrl } from '../lib/runtime.js';

function useQuery() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

export default function LogViewerScreen() {
  const q = useQuery();
  const jobId = q.get('jobId') || '';

  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('connecting');
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!jobId) {
      setStatus('missing_job_id');
      return;
    }

    const ev = openJobEventSource(jobId, {
      onLog: (line) => setLogs((s) => (s ? `${s}\n${line}` : String(line))),
      onProgress: () => {
        setStatus('running');
      },
      onStatus: (s) => {
        setStatus(s.status || 'done');
      },
    });

    return () => {
      try {
        ev.close();
      } catch {
        // ignore
      }
    };
  }, [jobId]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = document.getElementById('log-surface');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  function copy() {
    try {
      navigator.clipboard.writeText(logs || '');
    } catch {
      // ignore
    }
  }

  return (
    <div className="container" style={{ paddingTop: 24 }}>
      <div className="topbar" style={{ marginBottom: 14 }}>
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div>
            <h1 style={{ marginBottom: 2 }}>Logs</h1>
            <div className="subtitle">
              Job: <span className="mono">{jobId || '—'}</span> • Status: <span className="mono">{status}</span>
            </div>
          </div>
        </div>

        <div className="toolbar">
          <label className="check">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            <span className="field-label" style={{ margin: 0 }}>Auto-scroll</span>
          </label>
          <button className="btn" onClick={copy}>
            Copy
          </button>
          <button className="btn danger" onClick={() => setLogs('')}>
            Clear
          </button>
          <a className="btn" href={getHomeUrl()}>
            Back
          </a>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          id="log-surface"
          className="mono"
          style={{
            whiteSpace: 'pre-wrap',
            padding: 14,
            height: '74vh',
            overflow: 'auto',
            background:
              'radial-gradient(1000px 400px at 0% 0%, rgba(124,58,237,0.18), transparent 60%), rgba(0,0,0,0.35)',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {jobId ? logs || 'Waiting for logs…' : 'Missing jobId. Open this viewer from the Run tab.'}
        </div>
      </div>
    </div>
  );
}
