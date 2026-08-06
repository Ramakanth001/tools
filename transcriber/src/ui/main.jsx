import React from 'react';
import { createRoot } from 'react-dom/client';
import TranscriberTool from './TranscriberTool.jsx';
import '../../../pg-backup/src/ui/styles/global.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div><h1>transcriber</h1><div className="subtitle">Local Whisper speech-to-text</div></div>
        </div>
      </div>
      <TranscriberTool />
    </div>
  </React.StrictMode>
);
