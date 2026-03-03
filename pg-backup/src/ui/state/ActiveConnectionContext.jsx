import React, { createContext, useContext, useMemo, useState } from 'react';

/**
 * In-memory active connection (password is NOT persisted).
 *
 * This allows Schema/Run to share the same connection details without duplicating inputs.
 */

const ActiveConnectionContext = createContext(null);

export function ActiveConnectionProvider({ children }) {
  const [active, setActive] = useState({
    connectionString: '',
    pooler: {
      host: 'aws-1-ap-south-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.cughfeafhxhumjbijlpr',
      database: 'postgres',
      password: '',
    },
  });

  const value = useMemo(() => ({ active, setActive }), [active]);

  return <ActiveConnectionContext.Provider value={value}>{children}</ActiveConnectionContext.Provider>;
}

export function useActiveConnection() {
  const ctx = useContext(ActiveConnectionContext);
  if (!ctx) throw new Error('useActiveConnection must be used within ActiveConnectionProvider');
  return ctx;
}
