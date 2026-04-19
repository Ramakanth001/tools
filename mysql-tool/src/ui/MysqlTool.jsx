import React from 'react';
import App from './screens/App.jsx';
import { ActiveConnectionProvider } from './state/ActiveConnectionContext.jsx';
import { setMysqlToolRuntime } from './lib/runtime.js';

export default function MysqlTool({ runtime }) {
  setMysqlToolRuntime(runtime || {});
  return (
    <ActiveConnectionProvider>
      <App />
    </ActiveConnectionProvider>
  );
}