export const CHAT_MODELS = ['qwen3:14b-q4_K_M', 'qwen3:14b-q8_0'];
export const CONTEXT_OPTIONS = [8192, 12288, 16384];
export const TEMPERATURE_PRESETS = [
  { value: 0.1, label: 'Verbatim · 0.1', description: 'Exact corpus wording only — no paraphrasing' },
  { value: 0.3, label: 'Balanced · 0.3', description: 'Clear synthesis with conservative paraphrasing' },
  { value: 0.5, label: 'Natural · 0.5', description: 'More fluent and meaningful paraphrasing' },
  { value: 0.7, label: 'Interpretive · 0.7', description: 'Most expressive cross-source synthesis' },
];

export const DEFAULT_SETTINGS = {
  indexConnection: { connectionString: '', host: '127.0.0.1', port: 5433, user: 'spiritual_gpt_index_reader', password: '', database: 'universal_qa_index', sslMode: 'disable' },
  chatConnection: { connectionString: '', host: '127.0.0.1', port: 5433, user: 'spiritual_gpt_app', password: '', database: 'spiritual_gpt', sslMode: 'disable' },
  ollamaBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'embeddinggemma', chatModel: '',
  contextTokens: 8192, responseTemperature: 0.3, hardwarePreference: 'auto', unloadAfterTurn: false,
};

function migrateLegacyIndexConnection(connection) {
  if (connection.database === 'universal_qa_source' && connection.user === 'semantic_qa_reader') {
    return { ...connection, database: 'universal_qa_index', user: 'spiritual_gpt_index_reader', password: '', connectionString: '' };
  }
  return connection;
}

export function mergeSettings(value = {}, current = DEFAULT_SETTINGS) {
  const requestedContext = Number(value.contextTokens ?? current.contextTokens);
  return {
    ...DEFAULT_SETTINGS, ...current, ...value,
    contextTokens: CONTEXT_OPTIONS.includes(requestedContext) ? requestedContext : DEFAULT_SETTINGS.contextTokens,
    responseTemperature: TEMPERATURE_PRESETS.some((preset) => preset.value === Number(value.responseTemperature ?? current.responseTemperature))
      ? Number(value.responseTemperature ?? current.responseTemperature) : DEFAULT_SETTINGS.responseTemperature,
    unloadAfterTurn: value.unloadAfterTurn == null ? Boolean(current.unloadAfterTurn) : Boolean(value.unloadAfterTurn),
    indexConnection: migrateLegacyIndexConnection({ ...DEFAULT_SETTINGS.indexConnection, ...(current.indexConnection || {}), ...(value.indexConnection || {}) }),
    chatConnection: { ...DEFAULT_SETTINGS.chatConnection, ...(current.chatConnection || {}), ...(value.chatConnection || {}) },
  };
}

export function stripSecrets(value) {
  return {
    ...value,
    indexConnection: { ...value.indexConnection, password: '', connectionString: '' },
    chatConnection: { ...value.chatConnection, password: '', connectionString: '' },
  };
}
