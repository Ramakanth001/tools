export const DEFAULT_SETTINGS = {
  settingsVersion: 6,
  sourceConnection: { connectionString: '', host: '127.0.0.1', port: 5433, user: 'postgres', password: '', database: 'universal_qa_v2', sslMode: 'disable' },
  indexConnection: { connectionString: '', host: '127.0.0.1', port: 5433, user: 'postgres', password: '', database: 'universal_qa_v2', sslMode: 'disable' },
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'bge-m3',
  summaryModel: 'gemma3:4b',
  deepSummaryModel: 'qwen3:14b-q4_K_M',
  deepSummaryDeliberation: 'maximum',
  summaryHardwarePreference: 'auto',
  mapping: {
    schema: 'public',
    table: 'corpus_documents',
    idColumn: 'document_id',
    questionColumn: 'title',
    answerColumn: 'display_text',
    metadataColumns: ['source_type', 'original_record_id', 'master_id', 'question_context', 'raw_content_hash', 'display_text_hash', 'author', 'default_unit_kind', 'language', 'record_date', 'multimedia_filename', 'answer_unit_count', 'ambiguous', 'parser_report', 'legacy_aliases'],
    groupColumn: 'source_group',
    orderColumn: '',
  },
  topK: 35,
  threshold: 0.45,
  searchMode: 'search',
  summaryMode: 'standard',
  summaryEnabled: true,
  summaryMaxRecords: 15,
  summaryMaxLines: 3,
  deepSummaryMaxRecords: 60,
  deepSummaryParallelRequests: 1,
  deepSummaryTimeoutSeconds: 600,
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
  model: 'bge-m3',
  deepSummaryModel: 'qwen3:14b-q8_0',
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
    table: 'corpus_documents',
    idColumn: 'document_id',
    questionColumn: 'title',
    answerColumn: 'display_text',
    metadataColumns: ['source_type', 'original_record_id', 'master_id', 'question_context', 'raw_content_hash', 'display_text_hash', 'author', 'default_unit_kind', 'language', 'record_date', 'multimedia_filename', 'answer_unit_count', 'ambiguous', 'parser_report', 'legacy_aliases'],
    groupColumn: 'source_group',
    orderColumn: '',
  },
};

export function stripSecrets(settings) {
  return {
    ...settings,
    sourceConnection: { ...settings.sourceConnection, password: '', connectionString: '' },
    indexConnection: { ...settings.indexConnection, password: '', connectionString: '' },
  };
}

function columnNames(table) {
  return new Set((table?.columns || []).map((column) => column.name));
}

function firstMatchingColumn(table, preferredNames, fallbackPattern) {
  const columns = table?.columns || [];
  for (const name of preferredNames) {
    const match = columns.find((column) => column.name.toLowerCase() === name);
    if (match) return match.name;
  }
  return columns.find((column) => fallbackPattern.test(column.name))?.name || '';
}

// Catalog discovery must not erase a deliberately selected corpus preset. It
// only falls back to detection when the selected table or column is absent.
export function reconcileCatalogMapping(schemas = [], current = DEFAULT_SETTINGS.mapping) {
  const schema = schemas.find((item) => item.name === current.schema) || schemas[0];
  const table = schema?.tables?.find((item) => item.name === current.table) || schema?.tables?.[0];
  if (!schema || !table) return { ...DEFAULT_SETTINGS.mapping };
  const names = columnNames(table);
  const keep = (name) => (name && names.has(name) ? name : '');
  return {
    schema: schema.name,
    table: table.name,
    idColumn: keep(current.idColumn) || table.columns.find((column) => column.primaryKey)?.name || '',
    questionColumn: keep(current.questionColumn) || firstMatchingColumn(table, ['title', 'question', 'query'], /question|query|title/i),
    answerColumn: keep(current.answerColumn) || firstMatchingColumn(table, ['display_text', 'answer', 'response'], /display_text|answer|response/i),
    metadataColumns: (current.metadataColumns || []).filter((name) => names.has(name)),
    groupColumn: keep(current.groupColumn),
    orderColumn: keep(current.orderColumn),
  };
}

export function mergeSettings(value = {}) {
  const summaryMode = value.summaryMode || (value.summaryEnabled === false ? 'off' : 'standard');
  const storedVersion = Math.max(1, Math.trunc(Number(value.settingsVersion) || 1));
  const timeoutValue = storedVersion < 3 ? DEFAULT_SETTINGS.deepSummaryTimeoutSeconds : value.deepSummaryTimeoutSeconds;
  const storedSource = { ...DEFAULT_SETTINGS.sourceConnection, ...(value.sourceConnection || {}) };
  const storedIndex = { ...DEFAULT_SETTINGS.indexConnection, ...(value.indexConnection || {}) };
  if (!storedIndex.user || !storedIndex.database || Number(storedIndex.port) === 5432) {
    storedIndex.host = '127.0.0.1';
    storedIndex.port = 5433;
    storedIndex.user = 'postgres';
    storedIndex.database = 'universal_qa_v2';
  }
  if (!storedSource.user || !storedSource.database || Number(storedSource.port) === 5432) {
    storedSource.host = '127.0.0.1';
    storedSource.port = 5433;
    storedSource.user = 'postgres';
    storedSource.database = 'universal_qa_v2';
  }
  if (storedVersion < 5 && (storedIndex.database === 'universal_qa_index' || !storedIndex.database)) {
    storedIndex.database = 'universal_qa_v2';
  }
  const modelToUse = (storedVersion < 5 && value.model === 'embeddinggemma') ? 'bge-m3' : (value.model || DEFAULT_SETTINGS.model);
  const thresholdToUse = storedVersion < 5 && (value.threshold === 0.49 || value.threshold === 0.60) ? 0.45 : (value.threshold ?? DEFAULT_SETTINGS.threshold);
  const storedMapping = { ...DEFAULT_SETTINGS.mapping, ...(value.mapping || {}) };
  const migrateUniversalChunks = storedSource.database === 'universal_qa_source' &&
    (!storedMapping.table || storedMapping.table === 'qa_records');
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    model: modelToUse,
    threshold: thresholdToUse,
    searchMode: ['semantic', 'search', 'distance'].includes(value.searchMode) ? value.searchMode : DEFAULT_SETTINGS.searchMode,
    summaryMode: ['off', 'standard', 'deep'].includes(summaryMode) ? summaryMode : DEFAULT_SETTINGS.summaryMode,
    summaryHardwarePreference: ['auto', 'gpu', 'cpu'].includes(value.summaryHardwarePreference) ? value.summaryHardwarePreference : DEFAULT_SETTINGS.summaryHardwarePreference,
    deepSummaryMaxRecords: Math.max(1, Math.min(100, Math.trunc(Number(value.deepSummaryMaxRecords) || DEFAULT_SETTINGS.deepSummaryMaxRecords))),
    deepSummaryModel: ['qwen3:14b-q8_0', 'qwen3:14b-q4_K_M'].includes(value.deepSummaryModel) ? value.deepSummaryModel : DEFAULT_SETTINGS.deepSummaryModel,
    deepSummaryDeliberation: 'maximum',
    deepSummaryParallelRequests: 1,
    deepSummaryTimeoutSeconds: Math.max(60, Math.min(900, Math.trunc(Number(timeoutValue) || DEFAULT_SETTINGS.deepSummaryTimeoutSeconds))),
    sourceConnection: { ...storedSource, password: '', connectionString: '' },
    indexConnection: { ...storedIndex, password: '', connectionString: '' },
    mapping: migrateUniversalChunks ? { ...UNIVERSAL_QA_SETTINGS.mapping } : storedMapping,
  };
}
