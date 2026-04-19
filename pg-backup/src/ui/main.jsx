import React from 'react';
import { createRoot } from 'react-dom/client';
import PgBackupTool from './PgBackupTool.jsx';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PgBackupTool />
  </React.StrictMode>
);
