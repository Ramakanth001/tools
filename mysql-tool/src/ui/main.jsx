import React from 'react';
import { createRoot } from 'react-dom/client';
import MysqlTool from './MysqlTool.jsx';
import '../../../pg-backup/src/ui/styles/global.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MysqlTool
      runtime={{
        toolId: 'mysql-tool',
        apiBasePath: '/api',
        homePath: '/',
        logsPath: '/logs',
        storagePrefix: 'mysql-tool.standalone',
      }}
    />
  </React.StrictMode>
);