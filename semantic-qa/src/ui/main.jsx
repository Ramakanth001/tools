import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../pg-backup/src/ui/styles/global.css';
import SemanticQaTool, { STANDALONE_RUNTIME } from './SemanticQaTool.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <div className="container">
      <div className="topbar">
        <div className="brand"><div className="logo" aria-hidden="true" /><div><h1>semantic-qa</h1><div className="subtitle">Grounded retrieval from PostgreSQL Q&A records</div></div></div>
      </div>
      <SemanticQaTool runtime={STANDALONE_RUNTIME} />
    </div>
  </React.StrictMode>,
);
