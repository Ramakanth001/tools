export const DEFAULT_SETTINGS = {
  sourceConnection: { connectionString: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: 'postgres', sslMode: 'disable' },
  indexConnection: { connectionString: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: 'postgres', sslMode: 'disable' },
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'embeddinggemma',
  summaryModel: 'gemma3:4b',
  summaryHardwarePreference: 'auto',
  mapping: { schema: '', table: '', idColumn: '', questionColumn: '', answerColumn: '', metadataColumns: [], groupColumn: '', orderColumn: '' },
  topK: 5,
  threshold: 0.60,
  searchMode: 'semantic',
  summaryMode: 'standard',
  summaryEnabled: true,
  summaryMaxRecords: 15,
  summaryMaxLines: 3,
  deepSummaryMaxRecords: 60,
  deepSummaryParallelRequests: 2,
  deepSummaryTimeoutSeconds: 300,
  fetchSize: 250,
  embeddingBatchSize: 32,
};

export const LOCAL_DEMO_SETTINGS = {
  ...DEFAULT_SETTINGS,
  sourceConnection: {
    connectionString: '',
    host: '127.0.0.1',
    port: 5433,
    user: 'semantic_qa_reader',
    password: '',
    database: 'semantic_qa_source',
    sslMode: 'disable',
  },
  indexConnection: {
    connectionString: '',
    host: '127.0.0.1',
    port: 5433,
    user: 'semantic_qa_indexer',
    password: '',
    database: 'semantic_qa_index',
    sslMode: 'disable',
  },
  mapping: {
    schema: 'public',
    table: 'qa_records',
    idColumn: 'id',
    questionColumn: 'question',
    answerColumn: 'answer',
    metadataColumns: ['category', 'source_name'],
    groupColumn: '',
    orderColumn: '',
  },
};

export const UNIVERSAL_QA_SETTINGS = {
  ...LOCAL_DEMO_SETTINGS,
  threshold: 0.49,
  sourceConnection: {
    ...LOCAL_DEMO_SETTINGS.sourceConnection,
    database: 'universal_qa_source',
  },
  indexConnection: {
    ...LOCAL_DEMO_SETTINGS.indexConnection,
    database: 'universal_qa_index',
  },
  mapping: {
    schema: 'public',
    table: 'qa_records',
    idColumn: 'source_id',
    questionColumn: 'question',
    answerColumn: 'answer',
    metadataColumns: ['source_type', 'original_record_id', 'master_id', 'source_context', 'language', 'record_date', 'chunk_index', 'chunk_count'],
    groupColumn: 'source_group',
    orderColumn: 'chunk_index',
  },
};

export function stripSecrets(settings) {
  return {
    ...settings,
    sourceConnection: { ...settings.sourceConnection, password: '', connectionString: '' },
    indexConnection: { ...settings.indexConnection, password: '', connectionString: '' },
  };
}

export function mergeSettings(value = {}) {
  const summaryMode = value.summaryMode || (value.summaryEnabled === false ? 'off' : 'standard');
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    searchMode: ['semantic', 'search'].includes(value.searchMode) ? value.searchMode : DEFAULT_SETTINGS.searchMode,
    summaryMode: ['off', 'standard', 'deep'].includes(summaryMode) ? summaryMode : DEFAULT_SETTINGS.summaryMode,
    summaryHardwarePreference: ['auto', 'gpu', 'cpu'].includes(value.summaryHardwarePreference) ? value.summaryHardwarePreference : DEFAULT_SETTINGS.summaryHardwarePreference,
    deepSummaryParallelRequests: Math.max(1, Math.min(4, Math.trunc(Number(value.deepSummaryParallelRequests) || DEFAULT_SETTINGS.deepSummaryParallelRequests))),
    deepSummaryTimeoutSeconds: Math.max(60, Math.min(900, Math.trunc(Number(value.deepSummaryTimeoutSeconds) || DEFAULT_SETTINGS.deepSummaryTimeoutSeconds))),
    sourceConnection: { ...DEFAULT_SETTINGS.sourceConnection, ...(value.sourceConnection || {}), password: '', connectionString: '' },
    indexConnection: { ...DEFAULT_SETTINGS.indexConnection, ...(value.indexConnection || {}), password: '', connectionString: '' },
    mapping: { ...DEFAULT_SETTINGS.mapping, ...(value.mapping || {}) },
  };
}
