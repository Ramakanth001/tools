import React from 'react';
import App from './screens/App.jsx';
import { ActiveConnectionProvider } from './state/ActiveConnectionContext.jsx';
import { setPgBackupRuntime } from './lib/runtime.js';

export default function PgBackupTool({ runtime }) {
  setPgBackupRuntime(runtime || {});

  return (
    <ActiveConnectionProvider>
      <App />
    </ActiveConnectionProvider>
  );
}
