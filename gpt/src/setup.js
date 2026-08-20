const os = require('node:os');
const { requireToolDep } = require('../requireToolDep');
const { poolConfig } = require('./postgres');

const { Client } = requireToolDep('pg');

const INDEX_READER_ROLE = 'spiritual_gpt_index_reader';
const CHAT_ROLE = 'spiritual_gpt_app';
const CHAT_DATABASE = 'spiritual_gpt';
const CHAT_SCHEMA = 'gpt';
const REQUIRED_INDEX_TABLES = ['corpus', 'records', 'passages'];

function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '').trim().toLocaleLowerCase());
}

function identifier(value, label = 'identifier') {
  const text = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(text)) throw Object.assign(new Error(`${label} is not a safe PostgreSQL identifier`), { statusCode: 400 });
  return `"${text}"`;
}

function clientConfig(connection, database) {
  if (connection?.connectionString) throw Object.assign(new Error('Administrator setup uses the explicit local host fields, not a connection URL.'), { statusCode: 400 });
  if (!isLoopback(connection?.host)) throw Object.assign(new Error('Database provisioning is restricted to the local PostgreSQL server.'), { statusCode: 400 });
  if (!String(connection?.user || '').trim()) throw Object.assign(new Error('A local PostgreSQL administrator user is required.'), { statusCode: 400 });
  const port = Number(connection?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Administrator port must be between 1 and 65535.'), { statusCode: 400 });
  const config = poolConfig({ ...connection, database }, { applicationName: 'local-corpus-gpt-setup' });
  const { max, idleTimeoutMillis, ...client } = config;
  return { ...client, connectionTimeoutMillis: 10000 };
}

async function connect(ClientClass, config) {
  const client = new ClientClass(config);
  await client.connect();
  return client;
}

async function setRolePassword(client, role, password) {
  if (!password) return false;
  const quoted = await client.query('SELECT quote_literal($1::text) AS value', [String(password)]);
  await client.query(`ALTER ROLE ${identifier(role, 'role')} PASSWORD ${quoted.rows[0].value}`);
  return true;
}

async function ensureRole(client, role) {
  const exists = await client.query('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists', [role]);
  if (!exists.rows[0].exists) await client.query(`CREATE ROLE ${identifier(role, 'role')} LOGIN`);
}

async function provisionDatabases({ adminConnection, indexDatabase, indexRolePassword = '', chatRolePassword = '' }, { ClientClass = Client } = {}) {
  const targetIndex = String(indexDatabase || 'universal_qa_index').trim();
  identifier(targetIndex, 'Index database');
  if (String(indexRolePassword).length > 1024 || String(chatRolePassword).length > 1024) {
    throw Object.assign(new Error('Role passwords may not exceed 1,024 characters.'), { statusCode: 400 });
  }
  const admin = await connect(ClientClass, clientConfig(adminConnection, 'postgres'));
  let index;
  let chat;
  try {
    const indexExists = await admin.query('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists', [targetIndex]);
    if (!indexExists.rows[0].exists) throw Object.assign(new Error(`The Search Engine index database ${targetIndex} does not exist.`), { statusCode: 409 });
    index = await connect(ClientClass, clientConfig(adminConnection, targetIndex));
    const contract = await index.query(`SELECT to_regclass('semantic_qa.corpus') AS corpus,
      to_regclass('semantic_qa.records') AS records, to_regclass('semantic_qa.passages') AS passages`);
    const missing = REQUIRED_INDEX_TABLES.filter((table) => !contract.rows[0]?.[table]);
    if (missing.length) throw Object.assign(new Error(`The selected index is missing semantic_qa.${missing.join(', semantic_qa.')}.`), { statusCode: 409 });

    await ensureRole(admin, INDEX_READER_ROLE);
    await ensureRole(admin, CHAT_ROLE);
    await admin.query(`ALTER ROLE ${identifier(INDEX_READER_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`ALTER ROLE ${identifier(INDEX_READER_ROLE)} SET default_transaction_read_only = on`);
    await admin.query(`ALTER ROLE ${identifier(CHAT_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const indexPasswordSet = await setRolePassword(admin, INDEX_READER_ROLE, indexRolePassword);
    const chatPasswordSet = await setRolePassword(admin, CHAT_ROLE, chatRolePassword);

    const chatExists = await admin.query('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists', [CHAT_DATABASE]);
    if (!chatExists.rows[0].exists) await admin.query(`CREATE DATABASE ${identifier(CHAT_DATABASE)}`);

    await index.query(`GRANT CONNECT ON DATABASE ${identifier(targetIndex)} TO ${identifier(INDEX_READER_ROLE)}`);
    await index.query(`GRANT USAGE ON SCHEMA semantic_qa TO ${identifier(INDEX_READER_ROLE)}`);
    await index.query(`GRANT SELECT ON semantic_qa.corpus, semantic_qa.records, semantic_qa.passages TO ${identifier(INDEX_READER_ROLE)}`);
    const owners = await index.query(`SELECT DISTINCT tableowner FROM pg_tables
      WHERE schemaname = 'semantic_qa' AND tablename = ANY($1::text[])`, [REQUIRED_INDEX_TABLES]);
    for (const row of owners.rows) {
      await index.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(row.tableowner, 'table owner')} IN SCHEMA semantic_qa
        GRANT SELECT ON TABLES TO ${identifier(INDEX_READER_ROLE)}`);
    }

    chat = await connect(ClientClass, clientConfig(adminConnection, CHAT_DATABASE));
    await chat.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${identifier(CHAT_DATABASE)} FROM PUBLIC`);
    await chat.query(`GRANT CONNECT ON DATABASE ${identifier(CHAT_DATABASE)} TO ${identifier(CHAT_ROLE)}`);
    await chat.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await chat.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(CHAT_SCHEMA)} AUTHORIZATION ${identifier(CHAT_ROLE)}`);
    await chat.query(`ALTER SCHEMA ${identifier(CHAT_SCHEMA)} OWNER TO ${identifier(CHAT_ROLE)}`);
    await chat.query(`GRANT USAGE, CREATE ON SCHEMA ${identifier(CHAT_SCHEMA)} TO ${identifier(CHAT_ROLE)}`);

    return {
      indexDatabase: targetIndex,
      indexRole: INDEX_READER_ROLE,
      chatDatabase: CHAT_DATABASE,
      chatRole: CHAT_ROLE,
      passwordsUpdated: { index: indexPasswordSet, chat: chatPasswordSet },
    };
  } finally {
    await chat?.end().catch(() => undefined);
    await index?.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

function statusDefaults(indexDatabase = 'universal_qa_index') {
  return {
    adminConnection: { connectionString: '', host: '127.0.0.1', port: 5433, user: os.userInfo().username, password: '', database: 'postgres', sslMode: 'disable' },
    indexDatabase,
    indexRole: INDEX_READER_ROLE,
    chatDatabase: CHAT_DATABASE,
    chatRole: CHAT_ROLE,
    chatSchema: CHAT_SCHEMA,
  };
}

module.exports = { provisionDatabases, statusDefaults, isLoopback, identifier, clientConfig };
