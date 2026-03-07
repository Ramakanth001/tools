import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * In-memory active connection (password is NOT persisted).
 *
 * This allows Schema/Run to share the same connection details without duplicating inputs.
 */

const ActiveConnectionContext = createContext(null);

const SESSION_KEY = 'pgbackup.active_connection.session';

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function ActiveConnectionProvider({ children }) {
  const [active, setActive] = useState(() => {
    const s = loadSession();
    return {
      connectionString: s?.connectionString || '',
      pooler: {
        host: s?.pooler?.host || 'aws-1-ap-south-1.pooler.supabase.com',
        port: s?.pooler?.port || 5432,
        user: s?.pooler?.user || 'postgres.cughfeafhxhumjbijlpr',
        database: s?.pooler?.database || 'postgres',
        // password is NOT persisted
        password: '',
      },
    };
  });

  useEffect(() => {
    // Persist non-secret parts for the current browser session.
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          connectionString: active.connectionString || '',
          pooler: {
            host: active.pooler?.host || '',
            port: active.pooler?.port || 5432,
            user: active.pooler?.user || '',
            database: active.pooler?.database || '',
          },
        })
      );
    } catch {
      // ignore
    }
  }, [active.connectionString, active.pooler?.host, active.pooler?.port, active.pooler?.user, active.pooler?.database]);

  const value = useMemo(() => ({ active, setActive }), [active]);

  return <ActiveConnectionContext.Provider value={value}>{children}</ActiveConnectionContext.Provider>;
}

export function useActiveConnection() {
  const ctx = useContext(ActiveConnectionContext);
  if (!ctx) throw new Error('useActiveConnection must be used within ActiveConnectionProvider');
  return ctx;
}
