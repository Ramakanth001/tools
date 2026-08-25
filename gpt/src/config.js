const CHAT_MODELS = ['qwen3:14b-q4_K_M', 'qwen3:14b-q8_0'];
const CONTEXT_OPTIONS = [8192, 12288, 16384];
const TEMPERATURE_OPTIONS = [0.1, 0.3, 0.5, 0.7];
const RETRIEVAL_SCHEMA_VERSION = 'answer-unit-v5';
const EMBEDDING_FORMATS = new Set(['embeddinggemma-asymmetric-v2', 'embeddinggemma-asymmetric-v3']);

const DEFAULT_CONNECTION = {
  connectionString: '', host: '127.0.0.1', port: 5433, user: '', password: '', database: '', sslMode: 'disable',
};

const DEFAULT_SETTINGS = {
  indexConnection: { ...DEFAULT_CONNECTION, user: 'spiritual_gpt_index_reader', database: 'universal_qa_index' },
  chatConnection: { ...DEFAULT_CONNECTION, user: 'spiritual_gpt_app', database: 'spiritual_gpt' },
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  embeddingModel: 'embeddinggemma',
  chatModel: '',
  contextTokens: 8192,
  responseTemperature: 0.3,
  unloadAfterTurn: true,
  hardwarePreference: 'auto',
  benchmarkSeed: null,
};

function normalizeConnection(value = {}, fallback = DEFAULT_CONNECTION) {
  const sslMode = ['disable', 'prefer', 'require', 'verify-full'].includes(value.sslMode) ? value.sslMode : fallback.sslMode;
  return {
    ...fallback,
    ...value,
    host: String(value.host ?? fallback.host).trim(),
    port: Math.max(1, Math.min(65535, Number(value.port ?? fallback.port) || fallback.port)),
    user: String(value.user ?? fallback.user).trim(),
    password: String(value.password ?? fallback.password),
    database: String(value.database ?? fallback.database).trim(),
    connectionString: String(value.connectionString ?? fallback.connectionString).trim(),
    sslMode,
  };
}

function migrateLegacyIndexConnection(connection) {
  if (connection.database === 'universal_qa_source' && connection.user === 'semantic_qa_reader') {
    return {
      ...connection,
      database: DEFAULT_SETTINGS.indexConnection.database,
      user: DEFAULT_SETTINGS.indexConnection.user,
      password: '',
      connectionString: '',
    };
  }
  return connection;
}

function mergeSettings(value = {}, current = DEFAULT_SETTINGS) {
  const chatModel = CHAT_MODELS.includes(value.chatModel) ? value.chatModel : (CHAT_MODELS.includes(current.chatModel) ? current.chatModel : '');
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...value,
    chatModel,
    embeddingModel: String(value.embeddingModel ?? current.embeddingModel ?? 'embeddinggemma').trim() || 'embeddinggemma',
    ollamaBaseUrl: String(value.ollamaBaseUrl ?? current.ollamaBaseUrl ?? DEFAULT_SETTINGS.ollamaBaseUrl).trim(),
    contextTokens: CONTEXT_OPTIONS.includes(Number(value.contextTokens ?? current.contextTokens))
      ? Number(value.contextTokens ?? current.contextTokens) : DEFAULT_SETTINGS.contextTokens,
    responseTemperature: TEMPERATURE_OPTIONS.includes(Number(value.responseTemperature ?? current.responseTemperature))
      ? Number(value.responseTemperature ?? current.responseTemperature) : DEFAULT_SETTINGS.responseTemperature,
    unloadAfterTurn: value.unloadAfterTurn == null ? Boolean(current.unloadAfterTurn) : Boolean(value.unloadAfterTurn),
    benchmarkSeed: value.benchmarkSeed == null || value.benchmarkSeed === ''
      ? null : (Number.isInteger(Number(value.benchmarkSeed)) ? Number(value.benchmarkSeed) : null),
    hardwarePreference: ['auto', 'gpu', 'cpu'].includes(value.hardwarePreference) ? value.hardwarePreference : current.hardwarePreference,
    indexConnection: migrateLegacyIndexConnection(normalizeConnection(value.indexConnection || current.indexConnection, DEFAULT_SETTINGS.indexConnection)),
    chatConnection: normalizeConnection(value.chatConnection || current.chatConnection, DEFAULT_SETTINGS.chatConnection),
  };
}

function stripSecrets(settings) {
  return {
    ...settings,
    indexConnection: { ...settings.indexConnection, password: '', connectionString: '' },
    chatConnection: { ...settings.chatConnection, password: '', connectionString: '' },
  };
}

function configured(settings) {
  const validConnection = (connection) => Boolean(connection.connectionString || (connection.host && connection.user && connection.database));
  return Boolean(settings.chatModel && validConnection(settings.indexConnection) && validConnection(settings.chatConnection));
}

module.exports = {
  CHAT_MODELS, CONTEXT_OPTIONS, TEMPERATURE_OPTIONS, DEFAULT_SETTINGS, RETRIEVAL_SCHEMA_VERSION, EMBEDDING_FORMATS,
  mergeSettings, stripSecrets, configured,
};
