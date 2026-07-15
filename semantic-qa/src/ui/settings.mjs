export const DEFAULT_SETTINGS = {
  sourceConnection: { connectionString: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: 'postgres', sslMode: 'disable' },
  indexConnection: { connectionString: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: 'postgres', sslMode: 'disable' },
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'embeddinggemma',
  mapping: { schema: '', table: '', idColumn: '', questionColumn: '', answerColumn: '', metadataColumns: [], groupColumn: '', orderColumn: '' },
  topK: 5,
  threshold: 0.60,
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
    groupColumn: 'category',
    orderColumn: 'source_order',
  },
};

export const UNIVERSAL_QA_SETTINGS = {
  ...LOCAL_DEMO_SETTINGS,
  threshold: 0.50,
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
    metadataColumns: ['source_type', 'original_record_id', 'master_id', 'language', 'record_date', 'chunk_index', 'chunk_count'],
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
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    sourceConnection: { ...DEFAULT_SETTINGS.sourceConnection, ...(value.sourceConnection || {}), password: '', connectionString: '' },
    indexConnection: { ...DEFAULT_SETTINGS.indexConnection, ...(value.indexConnection || {}), password: '', connectionString: '' },
    mapping: { ...DEFAULT_SETTINGS.mapping, ...(value.mapping || {}) },
  };
}
