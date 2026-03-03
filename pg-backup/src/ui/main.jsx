import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './screens/App.jsx';
import './styles/global.css';
import { ActiveConnectionProvider } from './state/ActiveConnectionContext.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ActiveConnectionProvider>
      <App />
    </ActiveConnectionProvider>
  </React.StrictMode>
);
