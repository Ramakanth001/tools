import React from 'react';

export default function SettingsScreen() {
  return (
    <div className="grid">
      <div className="card">
        <h3>System checks</h3>
        <div className="alert warn">
          <div style={{ fontWeight: 800 }}>Important</div>
          <div className="hint" style={{ marginTop: 6 }}>
            This app runs <span className="mono">pg_dump</span> and <span className="mono">psql</span> on your machine.
            Install PostgreSQL client tools and ensure they are in PATH.
          </div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          macOS: <span className="mono">brew install postgresql@16</span> then{' '}
          <span className="mono">brew link --force postgresql@16</span>
        </div>
      </div>
      <div className="card">
        <h3>Security</h3>
        <div className="hint">Passwords are never stored. Connection strings are redacted in logs.</div>
      </div>
    </div>
  );
}
