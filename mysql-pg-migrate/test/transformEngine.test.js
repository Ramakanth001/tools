const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildDryRunPreview } = require('../src/lib/preflight');
const { buildTransformPreview, collectRequiredSourceColumnsForTableMapping, transformRowsForTable } = require('../src/lib/transformEngine');
const { normalizeMysqlConnection } = require('../src/lib/mysqlIntrospector');
const { createPersistence } = require('../src/state/persistence');
const { buildAlterTableAddConstraintSql } = require('../src/lib/sql');
const { validateTransformRule } = require('../src/lib/valueTransforms');

function mappingWith(columnMapping, patch = {}) {
  return {
    id: 'table-1',
    sourceTable: 'orders',
    targetTable: 'orders_pg',
    enabled: true,
    columnMappings: [columnMapping],
    ...patch,
  };
}

async function testStaticValueMapping() {
  const tableMapping = mappingWith({
    id: 'status',
    sourceColumn: 'status',
    targetColumn: 'status_code',
    transform: { type: 'lookup', config: { values: { 1: 'Y', 0: 'N' }, defaultValue: 'U' } },
    enabled: true,
  });

  const result = await transformRowsForTable({ rows: [{ status: '1' }, { status: '0' }, { status: 'x' }], tableMapping });
  assert.deepEqual(result.transformedRows, [{ status_code: 'Y' }, { status_code: 'N' }, { status_code: 'U' }]);
  assert.equal(result.rejected.length, 0);
}

async function testExpressionRequiredColumns() {
  const tableMapping = mappingWith({
    id: 'display',
    sourceColumn: 'first_name',
    targetColumn: 'display_name',
    transform: {
      type: 'expression',
      config: {
        expression: '[row.first_name, row.last_name].filter(Boolean).join(" ")',
        requiredColumns: ['last_name'],
      },
    },
    enabled: true,
  });

  assert.deepEqual(collectRequiredSourceColumnsForTableMapping(tableMapping).sort(), ['first_name', 'last_name']);
  const result = await transformRowsForTable({ rows: [{ first_name: 'Ada', last_name: 'Lovelace' }], tableMapping });
  assert.deepEqual(result.transformedRows, [{ display_name: 'Ada Lovelace' }]);
}

async function testLookupTableTransform() {
  const tableMapping = mappingWith({
    id: 'status',
    sourceColumn: 'status_id',
    targetColumn: 'status_label',
    transform: {
      type: 'lookup_table',
      config: {
        table: 'status_codes',
        localColumn: 'status_id',
        lookupColumn: 'id',
        valueColumn: 'label',
        missing: 'reject',
      },
    },
    enabled: true,
  });

  const result = await transformRowsForTable({
    rows: [{ status_id: 1 }],
    tableMapping,
    lookupRowsForSpec: async ({ spec, keys }) => {
      assert.equal(spec.table, 'status_codes');
      assert.deepEqual(keys, ['1']);
      return [{ lookup_key: 1, lookup_value: 'Active' }];
    },
  });

  assert.deepEqual(result.transformedRows, [{ status_label: 'Active' }]);
  assert.equal(result.lookupDependencies.length, 1);

  const missing = await transformRowsForTable({
    rows: [{ status_id: 9 }],
    tableMapping: {
      ...tableMapping,
      columnMappings: [{
        ...tableMapping.columnMappings[0],
        transform: { ...tableMapping.columnMappings[0].transform, config: { ...tableMapping.columnMappings[0].transform.config, missing: 'null' } },
      }],
    },
    lookupRowsForSpec: async () => [],
  });
  assert.deepEqual(missing.transformedRows, [{ status_label: null }]);
}

async function testRowFilterAndRejects() {
  const tableMapping = mappingWith({
    id: 'amount',
    sourceColumn: 'amount',
    targetColumn: 'amount',
    transform: { type: 'number', config: {} },
    enabled: true,
  }, {
    rowFilter: { enabled: true, expression: 'row.keep === true', config: { requiredColumns: ['keep'] } },
  });

  assert.deepEqual(collectRequiredSourceColumnsForTableMapping(tableMapping).sort(), ['amount', 'keep']);
  const result = await transformRowsForTable({
    rows: [{ amount: '10', keep: true }, { amount: '20', keep: false }, { amount: 'nope', keep: true }],
    tableMapping,
  });
  assert.deepEqual(result.transformedRows, [{ amount: 10 }]);
  assert.equal(result.filteredRowCount, 1);
  assert.equal(result.rejected.length, 1);
}

async function testDryRunPreviewUsesSharedTransform() {
  const tableMapping = mappingWith({
    id: 'status',
    sourceColumn: 'status',
    targetColumn: 'status_code',
    transform: { type: 'lookup', config: { values: { 1: 'Y' }, defaultValue: 'N' } },
    enabled: true,
  });
  const project = { tableMappings: [tableMapping] };

  const preview = await buildDryRunPreview({
    project,
    sampleSourceRows: async () => [{ status: '1' }, { status: '0' }],
    transformSampleRows: async (mapping, rows) => transformRowsForTable({ tableMapping: mapping, rows }),
  });

  assert.deepEqual(preview.tables[0].transformedRows, [{ status_code: 'Y' }, { status_code: 'N' }]);
}

async function testSelectedPreviewScopeDoesNotExpandToAllTables() {
  const orders = mappingWith({
    id: 'order_status',
    sourceColumn: 'status',
    targetColumn: 'status_code',
    transform: { type: 'lookup', config: { values: { 1: 'Y' }, defaultValue: 'N' } },
    enabled: true,
  });
  const customers = {
    ...mappingWith({
      id: 'customer_name',
      sourceColumn: 'name',
      targetColumn: 'name',
      transform: { type: 'direct', config: {} },
      enabled: true,
    }),
    id: 'table-2',
    sourceTable: 'customers',
    targetTable: 'customers_pg',
  };
  const project = { sourceSchema: 'app', tableMappings: [orders, customers] };

  const transformPreview = await buildTransformPreview({
    project,
    mode: 'selected',
    selectedTables: ['customers'],
    sampleSourceRows: async (tableName) => [{ status: '1', name: tableName }],
  });
  assert.deepEqual(transformPreview.scope, { mode: 'selected', selectedTables: ['customers'], sampleLimit: 5, loadPhase: 'configured' });
  assert.deepEqual(transformPreview.tables.map((table) => table.sourceTable), ['customers']);

  const emptySelectedPreview = await buildTransformPreview({
    project,
    mode: 'selected',
    selectedTables: [],
    sampleSourceRows: async () => [{ status: '1' }],
  });
  assert.deepEqual(emptySelectedPreview.tables, []);
}

async function testDryRunPreviewHonorsSelectedTables() {
  const orders = mappingWith({
    id: 'status',
    sourceColumn: 'status',
    targetColumn: 'status_code',
    transform: { type: 'lookup', config: { values: { 1: 'Y' }, defaultValue: 'N' } },
    enabled: true,
  });
  const customers = {
    ...mappingWith({
      id: 'name',
      sourceColumn: 'name',
      targetColumn: 'name',
      transform: { type: 'direct', config: {} },
      enabled: true,
    }),
    id: 'table-2',
    sourceTable: 'customers',
    targetTable: 'customers_pg',
  };

  const preview = await buildDryRunPreview({
    project: { tableMappings: [orders, customers] },
    mode: 'selected',
    selectedTables: ['orders'],
    sampleSourceRows: async (tableName) => [{ status: '1', name: tableName }],
    transformSampleRows: async (mapping, rows) => transformRowsForTable({ tableMapping: mapping, rows }),
  });

  assert.deepEqual(preview.scope, { mode: 'selected', selectedTables: ['orders'], sampleLimit: 5, loadPhase: 'configured' });
  assert.deepEqual(preview.tables.map((table) => table.sourceTable), ['orders']);
}

function testExpressionGuardRejectsEscapeHatches() {
  validateTransformRule({ type: 'expression', config: { expression: 'value == null ? null : String(value).trim()' } }, { value: ' x ' });
  assert.throws(
    () => validateTransformRule({ type: 'expression', config: { expression: 'value.constructor.constructor("return process")()' } }, { value: 'x' }),
    /unsupported token: constructor/i,
  );
}

function testMysqlConnectionStringNormalization() {
  const normalized = normalizeMysqlConnection({
    connectionString: 'mysql://app:secret@example.test:3307/shop?ssl-mode=VERIFY_CA&ssl-ca=/tmp/ca.pem',
  });
  assert.equal(normalized.host, 'example.test');
  assert.equal(normalized.port, 3307);
  assert.equal(normalized.user, 'app');
  assert.equal(normalized.password, 'secret');
  assert.equal(normalized.database, 'shop');
  assert.equal(normalized.sslMode, 'VERIFY_CA');
  assert.equal(normalized.sslCa, '/tmp/ca.pem');
}

function testConstraintSqlIsIdempotent() {
  const statements = buildAlterTableAddConstraintSql({
    schema: 'public',
    table: 'users',
    constraints: [{ type: 'unique', name: 'users_email_key', columns: ['email'] }],
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /IF NOT EXISTS/);
  assert.match(statements[0], /ADD CONSTRAINT "users_email_key" UNIQUE/);
}

async function testPersistenceRejectsUnsafeIds() {
  const rootDir = path.join(os.tmpdir(), `mysql-pg-migrate-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const persistence = createPersistence({ rootDir });
  try {
    await assert.rejects(() => persistence.saveProject({ id: '../outside', name: 'bad' }), /Invalid projects/);
    assert.equal(await persistence.getProject('../outside'), null);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Mojibake Repair Tests
// ---------------------------------------------------------------------------

const { detectMojibake, repairMojibake, validateRepair, isValidIAST } = require('../src/lib/mojibakeRepair');
const { resolveTransformPreset } = require('../src/lib/transformCatalog');

async function testMojibakeRepairTransform() {
  // Build a mapping with mojibake_repair transform on a text column
  const tableMapping = mappingWith({
    id: 'title',
    sourceColumn: 'title',
    targetColumn: 'title',
    transform: { type: 'mojibake_repair', config: { mode: 'force' } },
    enabled: true,
  });

  // Simulate corrupted IAST text: ā becomes \u00C4\u0081 in mojibake
  const corruptedTitle = 'The \u00C4\u0081tman and Brahman';
  const result = await transformRowsForTable({
    rows: [{ title: corruptedTitle }],
    tableMapping,
  });

  assert.equal(result.rejected.length, 0, 'No rows should be rejected');
  assert.equal(result.transformedRows.length, 1);
  assert.equal(result.transformedRows[0].title, 'The \u0101tman and Brahman');
}

async function testMojibakeRepairMultipleCharacters() {
  const tableMapping = mappingWith({
    id: 'content',
    sourceColumn: 'content',
    targetColumn: 'content',
    transform: { type: 'mojibake_repair', config: { mode: 'force' } },
    enabled: true,
  });

  // Text with multiple corrupted IAST characters
  const corrupted = '\u00E1\u00B9\u00A3a\u00E1\u00B9\u00ADka\u00E1\u00B9\u0087a \u00C5\u009Br\u00C4\u00AB';
  const result = await transformRowsForTable({
    rows: [{ content: corrupted }],
    tableMapping,
  });

  assert.equal(result.transformedRows[0].content, '\u1E63a\u1E6Dka\u1E47a \u015Br\u012B');
}

function testMojibakeDetection() {
  // Should detect mojibake in corrupted text
  const corrupted = 'Mah\u00C4\u0081bh\u00C4\u0081rata \u00E1\u00B9\u00A3loka';
  const detection = detectMojibake(corrupted);
  assert.equal(detection.isMojibake, true);
  assert.ok(detection.confidence > 0, 'Confidence should be positive');
  assert.ok(detection.sampleCorruptions.length > 0, 'Should report sample corruptions');

  // Should NOT detect mojibake in clean text
  const clean = 'Mah\u0101bh\u0101rata \u1E63loka';
  const cleanDetection = detectMojibake(clean);
  assert.equal(cleanDetection.isMojibake, false);
  assert.equal(cleanDetection.confidence, 0);

  // Should NOT detect mojibake in plain ASCII
  const ascii = 'Hello world, this is plain text.';
  const asciiDetection = detectMojibake(ascii);
  assert.equal(asciiDetection.isMojibake, false);

  // Should handle null/empty gracefully
  assert.equal(detectMojibake(null).isMojibake, false);
  assert.equal(detectMojibake('').isMojibake, false);
}

async function testMojibakeDetectOnlyMode() {
  const tableMapping = mappingWith({
    id: 'title',
    sourceColumn: 'title',
    targetColumn: 'title',
    transform: { type: 'mojibake_repair', config: { mode: 'detect_only' } },
    enabled: true,
  });

  const corrupted = 'The \u00C4\u0081tman';
  const result = await transformRowsForTable({
    rows: [{ title: corrupted }],
    tableMapping,
  });

  // detect_only should return the original text unchanged
  assert.equal(result.transformedRows[0].title, corrupted);
}

function testMojibakePresetResolves() {
  const unicodePreset = resolveTransformPreset('repair_unicode_mojibake');
  assert.ok(unicodePreset, 'repair_unicode_mojibake preset should exist');
  assert.equal(unicodePreset.type, 'mojibake_repair');
  assert.equal(unicodePreset.config.mode, 'auto');

  const iastPreset = resolveTransformPreset('repair_iast_mojibake');
  assert.ok(iastPreset, 'repair_iast_mojibake preset should exist');
  assert.equal(iastPreset.type, 'mojibake_repair');
  assert.equal(iastPreset.config.mode, 'auto');
}

function testCleanIASTPassesThrough() {
  // Properly-encoded IAST text should not be modified
  const clean = 'dhy\u0101na praj\u00F1\u0101 \u015B\u0101nti sa\u1E43s\u0101ra vi\u1E63\u1E47u \u1E5B\u1E63i k\u1E5Bd\u0101nta \u1E37\u012Bl\u0101';
  const repaired = repairMojibake(clean, { mode: 'auto' });
  assert.equal(repaired, clean, 'Clean IAST text should pass through unmodified');

  // Also verify isValidIAST identifies it as valid
  assert.equal(isValidIAST(clean), true);
}

function testAlreadyCorrectUnicode() {
  const samples = [
    'నారాయణుడు',
    'śrī kṛṣṇa',
    'Mahābhārata śloka',
    'Résumé & Naïve',
    'äöüß',
    '日本語 - Clean Japanese Text',
  ];

  for (const sample of samples) {
    const detection = detectMojibake(sample);
    assert.equal(detection.isMojibake, false, `Should not detect mojibake in clean text: ${sample}`);
    const repaired = repairMojibake(sample, { mode: 'auto' });
    assert.equal(repaired, sample, `Clean text should be unchanged: ${sample}`);
  }
}

function testFalsePositives() {
  const falsePositives = [
    'Hello World!',
    'MySQL to PostgreSQL Migration Tool',
    'user_id = 12345',
    'standard text without accents',
    'నారాయణుడు',
  ];

  for (const text of falsePositives) {
    const detection = detectMojibake(text);
    assert.equal(detection.isMojibake, false, `False positive test failed for: ${text}`);
    assert.equal(detection.confidence, 0);
  }
}

function testMojibakeRepairIdempotency() {
  const corruptedSamples = [
    'Å›rÄ« ká¹›á¹£á¹‡a',
    '\u00E1\u00B9\u00A3a\u00E1\u00B9\u00ADka\u00E1\u00B9\u0087a \u00C5\u009Br\u00C4\u00AB',
    'à°®à°°à°šà°¿à°ªà±‹à°•à±à°®à± à°¦à°¤à±à°¨à°· à°®à°‚à°šà°¿à°®à°¾à°Ÿ',
  ];

  for (const corrupted of corruptedSamples) {
    const firstPassForce = repairMojibake(corrupted, { mode: 'force' });
    const secondPassForce = repairMojibake(firstPassForce, { mode: 'force' });
    assert.equal(secondPassForce, firstPassForce, 'Force repair should be idempotent');

    const firstPassAuto = repairMojibake(corrupted, { mode: 'auto' });
    const secondPassAuto = repairMojibake(firstPassAuto, { mode: 'auto' });
    assert.equal(secondPassAuto, firstPassAuto, 'Auto repair should be idempotent');
  }
}

async function testMojibakeRepairNullHandling() {
  const tableMapping = mappingWith({
    id: 'title',
    sourceColumn: 'title',
    targetColumn: 'title',
    transform: { type: 'mojibake_repair', config: { mode: 'auto' } },
    enabled: true,
  });

  const result = await transformRowsForTable({
    rows: [{ title: null }, { title: '' }, { title: 'plain text' }],
    tableMapping,
  });

  assert.equal(result.transformedRows[0].title, null, 'null should remain null');
  assert.equal(result.transformedRows[1].title, '', 'empty string should remain empty');
  assert.equal(result.transformedRows[2].title, 'plain text', 'plain text should pass through');
}

function testTeluguMojibakeRepair() {
  const corrupted1 = 'à°®à°°à°šà°¿à°ªà±‹à°•à±à°®à± à°¦à°¤à±à°¨à°¿ à°®à°‚à°šà°¿à°®à°¾à°Ÿ (Part-9)';
  const detection1 = detectMojibake(corrupted1);
  assert.equal(detection1.isMojibake, true);
  const repaired1 = repairMojibake(corrupted1, { mode: 'auto' });
  assert.ok(repaired1.includes('మరచిపో'), 'Should repair Telugu Mojibake into clean script');

  const corrupted2 = 'à°¨à°¾à°°à°¾à°¯à°£à±\u0081à°¡à±\u0081';
  const detection2 = detectMojibake(corrupted2);
  assert.equal(detection2.isMojibake, true);
  const repaired2 = repairMojibake(corrupted2, { mode: 'auto' });
  assert.equal(repaired2, 'నారాయణుడు', 'Should repair corrupted Telugu name to నారాయణుడు');
}

function testIASTMojibakeRepair() {
  const corrupted = 'Å›rÄ« ká¹›á¹£á¹‡a';
  const detection = detectMojibake(corrupted);
  assert.equal(detection.isMojibake, true);
  const repaired = repairMojibake(corrupted, { mode: 'auto' });
  assert.equal(repaired, 'śrī kṛṣṇa', 'Should repair Å›rÄ« ká¹›á¹£á¹‡a to śrī kṛṣṇa');
}

function testValidateRepair() {
  const corrupted = 'Å›rÄ« ká¹›á¹£á¹‡a';
  const repaired = repairMojibake(corrupted, { mode: 'auto' });

  const invalidResult = validateRepair(corrupted);
  assert.equal(invalidResult.isValid, false);
  assert.equal(invalidResult.isMojibakeFree, false);

  const validResult = validateRepair(repaired);
  assert.equal(validResult.isValid, true);
  assert.equal(validResult.isMojibakeFree, true);
  assert.equal(validResult.confidence, 1.0);

  const pairResult = validateRepair(corrupted, repaired);
  assert.equal(pairResult.isValid, true);
  assert.equal(pairResult.original, corrupted);
  assert.equal(pairResult.repaired, repaired);
}

async function main() {
  await testStaticValueMapping();
  await testExpressionRequiredColumns();
  await testLookupTableTransform();
  await testRowFilterAndRejects();
  await testDryRunPreviewUsesSharedTransform();
  await testSelectedPreviewScopeDoesNotExpandToAllTables();
  await testDryRunPreviewHonorsSelectedTables();
  testExpressionGuardRejectsEscapeHatches();
  testMysqlConnectionStringNormalization();
  testConstraintSqlIsIdempotent();
  await testPersistenceRejectsUnsafeIds();
  // Mojibake repair tests
  await testMojibakeRepairTransform();
  await testMojibakeRepairMultipleCharacters();
  testMojibakeDetection();
  await testMojibakeDetectOnlyMode();
  testMojibakePresetResolves();
  testCleanIASTPassesThrough();
  testAlreadyCorrectUnicode();
  testFalsePositives();
  testMojibakeRepairIdempotency();
  await testMojibakeRepairNullHandling();
  testTeluguMojibakeRepair();
  testIASTMojibakeRepair();
  testValidateRepair();
  console.log('transformEngine tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

