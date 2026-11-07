const test = require('node:test');
const assert = require('node:assert/strict');

test('persisted UI settings remove both passwords and connection strings', async () => {
  const { LOCAL_DEMO_SETTINGS, UNIVERSAL_QA_SETTINGS, stripSecrets, mergeSettings, reconcileCatalogMapping } = await import('../src/ui/settings.mjs');
  const persisted = stripSecrets({
    sourceConnection: { host: 'source', password: 'source-secret', connectionString: 'postgres://source' },
    indexConnection: { host: 'index', password: 'index-secret', connectionString: 'postgres://index' },
    threshold: 0.7,
  });
  assert.equal(persisted.sourceConnection.password, '');
  assert.equal(persisted.sourceConnection.connectionString, '');
  assert.equal(persisted.indexConnection.password, '');
  assert.equal(persisted.indexConnection.connectionString, '');
  assert.equal(persisted.threshold, 0.7);

  const loaded = mergeSettings({ sourceConnection: { password: 'should-not-load', connectionString: 'should-not-load' } });
  assert.equal(loaded.sourceConnection.password, '');
  assert.equal(loaded.sourceConnection.connectionString, '');
  assert.equal(LOCAL_DEMO_SETTINGS.sourceConnection.port, 5433);
  assert.equal(LOCAL_DEMO_SETTINGS.sourceConnection.database, 'semantic_qa_source');
  assert.equal(LOCAL_DEMO_SETTINGS.indexConnection.database, 'semantic_qa_index');
  assert.equal(LOCAL_DEMO_SETTINGS.mapping.answerColumn, 'answer');
  assert.equal(LOCAL_DEMO_SETTINGS.mapping.groupColumn, '');
  assert.equal(LOCAL_DEMO_SETTINGS.mapping.orderColumn, '');
  assert.ok(LOCAL_DEMO_SETTINGS.mapping.metadataColumns.includes('category'));
  assert.equal(UNIVERSAL_QA_SETTINGS.sourceConnection.database, 'universal_qa_source');
  assert.equal(UNIVERSAL_QA_SETTINGS.indexConnection.database, 'universal_qa_index');
  assert.equal(UNIVERSAL_QA_SETTINGS.mapping.table, 'corpus_documents');
  assert.equal(UNIVERSAL_QA_SETTINGS.mapping.idColumn, 'document_id');
  assert.equal(UNIVERSAL_QA_SETTINGS.mapping.answerColumn, 'display_text');
  assert.equal(UNIVERSAL_QA_SETTINGS.threshold, 0.49);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryEnabled, true);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryMaxRecords, 15);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryMaxLines, 3);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryHardwarePreference, 'auto');
  assert.equal(UNIVERSAL_QA_SETTINGS.deepSummaryMaxRecords, 60);
  assert.equal(UNIVERSAL_QA_SETTINGS.deepSummaryModel, 'qwen3:14b-q8_0');
  assert.equal(UNIVERSAL_QA_SETTINGS.deepSummaryParallelRequests, 1);
  assert.equal(UNIVERSAL_QA_SETTINGS.deepSummaryTimeoutSeconds, 600);

  const boundedDeepSettings = mergeSettings({ settingsVersion: 3, deepSummaryMaxRecords: 999, deepSummaryParallelRequests: 99, deepSummaryTimeoutSeconds: 10 });
  assert.equal(boundedDeepSettings.deepSummaryMaxRecords, 100);
  assert.equal(boundedDeepSettings.deepSummaryParallelRequests, 1);
  assert.equal(boundedDeepSettings.deepSummaryTimeoutSeconds, 60);
  assert.equal(mergeSettings({ deepSummaryTimeoutSeconds: 300 }).deepSummaryTimeoutSeconds, 600);
  assert.equal(mergeSettings({ settingsVersion: 3, deepSummaryTimeoutSeconds: 300 }).deepSummaryTimeoutSeconds, 300);
  assert.equal(mergeSettings({ summaryHardwarePreference: 'invalid' }).summaryHardwarePreference, 'auto');

  const migratedUniversal = mergeSettings({
    settingsVersion: 3,
    sourceConnection: { database: 'universal_qa_source' },
    mapping: { schema: 'public', table: 'qa_records', idColumn: 'source_id', questionColumn: 'question', answerColumn: 'answer' },
  });
  assert.equal(migratedUniversal.mapping.table, 'corpus_documents');
  assert.equal(migratedUniversal.mapping.idColumn, 'document_id');
  assert.equal(migratedUniversal.mapping.answerColumn, 'display_text');

  const catalog = [{ name: 'public', tables: [{ name: 'corpus_documents', columns: [
    { name: 'document_id', primaryKey: true }, { name: 'title' }, { name: 'question_context' },
    { name: 'display_text' }, { name: 'source_group' }, { name: 'author' },
  ] }] }];
  const reconciled = reconcileCatalogMapping(catalog, {
    ...UNIVERSAL_QA_SETTINGS.mapping,
    metadataColumns: ['question_context', 'author', 'missing_column'],
  });
  assert.equal(reconciled.questionColumn, 'title');
  assert.equal(reconciled.answerColumn, 'display_text');
  assert.equal(reconciled.groupColumn, 'source_group');
  assert.deepEqual(reconciled.metadataColumns, ['question_context', 'author']);
});
