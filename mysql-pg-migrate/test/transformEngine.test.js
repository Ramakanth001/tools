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
  console.log('transformEngine tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
