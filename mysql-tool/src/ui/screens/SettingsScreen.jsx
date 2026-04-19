import React from 'react';

export default function SettingsScreen() {
  return (
    <div className="grid">
      <div className="card">
        <h3>System checks</h3>
        <div className="alert warn">
          <div style={{ fontWeight: 800 }}>Important</div>
          <div className="hint" style={{ marginTop: 6 }}>
            This app runs <span className="mono">mysqldump</span> and <span className="mono">mysql</span> on your machine.
            Install MySQL client tools and ensure they are in PATH.
          </div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>macOS: <span className="mono">brew install mysql-client</span></div>
      </div>
      <div className="card">
        <h3>Security</h3>
        <div className="hint">Passwords are never stored. Connection details are redacted in logs whenever possible.</div>
      </div>
    </div>
  );
}