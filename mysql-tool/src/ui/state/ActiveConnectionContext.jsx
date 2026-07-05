import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getStorageKey } from '../lib/runtime.js';

const ActiveConnectionContext = createContext(null);

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(getStorageKey('active_connection.session'));
    const parsed = raw ? safeJsonParse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function ActiveConnectionProvider({ children }) {
  const [active, setActive] = useState(() => {
    const s = loadSession();
    return {
      connection: {
        host: s?.connection?.host || '127.0.0.1',
        port: s?.connection?.port || 3306,
        user: s?.connection?.user || 'root',
        password: '',
        database: s?.connection?.database || '',
        sslMode: s?.connection?.sslMode || 'PREFERRED',
        sslCa: s?.connection?.sslCa || '',
        sslCert: s?.connection?.sslCert || '',
        sslKey: '',
        connectionString: s?.connection?.connectionString || '',
      },
    };
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(getStorageKey('active_connection.session'), JSON.stringify({ connection: { host: active.connection?.host || '', port: active.connection?.port || 3306, user: active.connection?.user || '', database: active.connection?.database || '', sslMode: active.connection?.sslMode || 'PREFERRED', sslCa: active.connection?.sslCa || '', sslCert: active.connection?.sslCert || '', connectionString: active.connection?.connectionString || '' } }));
    } catch {
      // ignore
    }
  }, [active.connection?.host, active.connection?.port, active.connection?.user, active.connection?.database, active.connection?.sslMode, active.connection?.sslCa, active.connection?.sslCert, active.connection?.connectionString]);

  const value = useMemo(() => ({ active, setActive }), [active]);
  return <ActiveConnectionContext.Provider value={value}>{children}</ActiveConnectionContext.Provider>;
}

export function useActiveConnection() {
  const ctx = useContext(ActiveConnectionContext);
  if (!ctx) throw new Error('useActiveConnection must be used within ActiveConnectionProvider');
  return ctx;
}
