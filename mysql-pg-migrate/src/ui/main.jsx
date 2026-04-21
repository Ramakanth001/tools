import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../pg-backup/src/ui/styles/global.css';

function App() {
  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div>
            <h1>mysql-pg-migrate</h1>
            <div className="subtitle">MySQL to PostgreSQL migration workflow tool</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3 style={{ margin: 0 }}>UI scaffold ready</h3>
            <div className="hint" style={{ marginTop: 6 }}>
              The standalone build now has a valid frontend entry point. Backend APIs are available at <span className="mono">/api</span>.
            </div>
          </div>
          <div className="toolbar">
            <span className="badge">React + Vite</span>
          </div>
        </div>

        <div className="panel-body">
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0 }}>Available today</h3>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Schema introspection endpoints</li>
              <li>Auto-mapping project creation</li>
              <li>Preflight and dry-run APIs</li>
              <li>Run, resume, rerun-failed, and report endpoints</li>
            </ul>
            <div className="hint">
              This placeholder UI is enough to make <span className="mono">npm run build</span> and the standalone app valid while fuller screens are implemented.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);