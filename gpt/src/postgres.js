const { requireToolDep } = require('../requireToolDep');
const { Pool } = requireToolDep('pg');

function poolConfig(connection = {}, { readOnly = false, applicationName = 'local-corpus-gpt' } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(connection.host || '').toLowerCase());
  const sslMode = String(connection.sslMode || 'prefer');
  const ssl = sslMode === 'disable' || (sslMode === 'prefer' && loopback)
    ? false
    : sslMode === 'verify-full' ? { rejectUnauthorized: true } : { rejectUnauthorized: false };
  const common = {
    max: readOnly ? 4 : 6,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 10000,
    application_name: applicationName,
    ...(readOnly ? { options: '-c default_transaction_read_only=on -c statement_timeout=15000' } : {}),
  };
  if (String(connection.connectionString || '').trim()) {
    return { ...common, connectionString: String(connection.connectionString).trim() };
  }
  return {
    ...common,
    host: String(connection.host || '127.0.0.1'),
    port: Number(connection.port || 5432),
    user: String(connection.user || ''),
    password: String(connection.password || ''),
    database: String(connection.database || 'postgres'),
    ssl,
  };
}

function connectionFingerprint(connection = {}) {
  return JSON.stringify({
    connectionString: connection.connectionString || '', host: connection.host || '', port: connection.port || 5432,
    user: connection.user || '', password: connection.password || '', database: connection.database || '', sslMode: connection.sslMode || '',
  });
}

class ConfigurablePool {
  constructor(options = {}) {
    this.options = options;
    this.pool = null;
    this.fingerprint = '';
  }

  async configure(connection) {
    const next = connectionFingerprint(connection);
    if (this.pool && next === this.fingerprint) return this.pool;
    const previous = this.pool;
    this.pool = new Pool(poolConfig(connection, this.options));
    this.fingerprint = next;
    if (previous) await previous.end().catch(() => undefined);
    return this.pool;
  }

  async close() {
    const current = this.pool;
    this.pool = null;
    this.fingerprint = '';
    if (current) await current.end().catch(() => undefined);
  }
}

module.exports = { poolConfig, ConfigurablePool };
