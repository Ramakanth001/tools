import React, { useMemo, useState } from 'react';
import RunScreen from './RunScreen.jsx';
import { SchemaScreenWithProvider as SchemaScreen } from './SchemaScreen.jsx';
import HistoryScreen from './HistoryScreen.jsx';
import SettingsScreen from './SettingsScreen.jsx';
import LogViewerScreen from './LogViewerScreen.jsx';
import { getStorageKey, isLogsPath } from '../lib/runtime.js';

const TABS = [
  { id: 'run', label: 'Run' },
  { id: 'schema', label: 'Schema' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const isLogs = typeof window !== 'undefined' && isLogsPath(window.location.pathname);
  if (isLogs) return <LogViewerScreen />;

  const tabKey = getStorageKey('tab');
  const [tab, setTab] = useState(() => localStorage.getItem(tabKey) || 'run');
  const active = useMemo(() => (TABS.some((t) => t.id === tab) ? tab : 'run'), [tab]);

  function setActive(next) {
    setTab(next);
    localStorage.setItem(tabKey, next);
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div>
            <h1>pg-backup</h1>
            <div className="subtitle">
              Local, real PostgreSQL backups via <span className="mono">pg_dump</span> + <span className="mono">psql</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="tabs" role="tablist" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="tab"
                role="tab"
                aria-selected={active === t.id}
                onClick={() => setActive(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <span className="badge">UI (React)</span>
          </div>
        </div>

        <div className="panel-body">
          {active === 'run' && <RunScreen />}
          {active === 'schema' && <SchemaScreen />}
          {active === 'history' && <HistoryScreen />}
          {active === 'settings' && <SettingsScreen />}
        </div>
      </div>
    </div>
  );
}
