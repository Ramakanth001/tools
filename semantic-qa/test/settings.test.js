const test = require('node:test');
const assert = require('node:assert/strict');

test('persisted UI settings remove both passwords and connection strings', async () => {
  const { LOCAL_DEMO_SETTINGS, UNIVERSAL_QA_SETTINGS, stripSecrets, mergeSettings } = await import('../src/ui/settings.mjs');
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
  assert.equal(UNIVERSAL_QA_SETTINGS.mapping.idColumn, 'source_id');
  assert.equal(UNIVERSAL_QA_SETTINGS.threshold, 0.49);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryEnabled, true);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryMaxRecords, 15);
  assert.equal(UNIVERSAL_QA_SETTINGS.summaryMaxLines, 3);
});
