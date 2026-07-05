const crypto = require('node:crypto');

const { quoteMysqlIdentifier, runMysqlQuery, runMysqlSessionQuery, normalizeMysqlConnection } = require('./mysqlIntrospector');
const { normalizeTransform, shouldIncludeRow, transformRow, validateTransformRule } = require('./valueTransforms');

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedObject(value[key]);
  return out;
}

function transformFingerprint(project = {}) {
  return stableHash(sortedObject({
    tableMappings: (project.tableMappings || []).map((mapping) => ({
      id: mapping.id,
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      enabled: mapping.enabled !== false,
      rowFilter: mapping.rowFilter || null,
      columnMappings: (mapping.columnMappings || []).map((column) => ({
        id: column.id,
        sourceColumn: column.sourceColumn,
        targetColumn: column.targetColumn || null,
        targetColumnMode: column.targetColumnMode || null,
        enabled: column.enabled !== false,
        transform: column.transform || { type: 'direct', config: {} },
      })),
    })),
    sourceFingerprint: project.sourceFingerprint || project.sourceCatalog?.fingerprint || null,
    targetFingerprint: project.targetFingerprint || project.targetCatalog?.fingerprint || null,
  }));
}

function addColumn(columns, name) {
  const value = String(name || '').trim();
  if (value) columns.add(value);
}

function configuredColumns(config = {}) {
  const raw = config.requiredColumns;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function expressionColumns(expression) {
  const text = String(expression || '');
  const columns = new Set();
  const dotPattern = /\b(?:row|sourceRow)\.([A-Za-z_$][\w$]*)/g;
  const bracketPattern = /\b(?:row|sourceRow)\[\s*['"`]([^'"`\]]+)['"`]\s*\]/g;
  let match = dotPattern.exec(text);
  while (match) {
    addColumn(columns, match[1]);
    match = dotPattern.exec(text);
  }
  match = bracketPattern.exec(text);
  while (match) {
    addColumn(columns, match[1]);
    match = bracketPattern.exec(text);
  }
  return Array.from(columns);
}

function templateColumns(template) {
  const text = String(template || '');
  const columns = new Set();
  const pattern = /\{\{\s*([\w$.-]+)\s*\}\}/g;
  let match = pattern.exec(text);
  while (match) {
    addColumn(columns, match[1]);
    match = pattern.exec(text);
  }
  return Array.from(columns);
}

function collectTransformSourceColumns(transform, fallbackSourceColumn) {
  const columns = new Set();
  addColumn(columns, fallbackSourceColumn);
  const rule = normalizeTransform(transform);
  const config = rule.config || {};
  for (const column of configuredColumns(config)) addColumn(columns, column);
  for (const column of expressionColumns(config.when)) addColumn(columns, column);

  if (rule.type === 'template') {
    for (const column of templateColumns(config.template)) addColumn(columns, column);
  }
  if (rule.type === 'expression') {
    for (const column of expressionColumns(config.expression)) addColumn(columns, column);
  }
  if (rule.type === 'concat' || rule.type === 'coalesce') {
    for (const column of config.fields || []) addColumn(columns, column);
  }
  if (rule.type === 'lookup_table') {
    addColumn(columns, config.localColumn || fallbackSourceColumn);
  }
  if (rule.type === 'conditional') {
    for (const branch of config.branches || []) {
      for (const column of expressionColumns(branch?.when)) addColumn(columns, column);
      for (const column of collectTransformSourceColumns(branch?.then || { type: 'direct', config: {} }, fallbackSourceColumn)) addColumn(columns, column);
    }
    if (config.otherwise) {
      for (const column of collectTransformSourceColumns(config.otherwise, fallbackSourceColumn)) addColumn(columns, column);
    }
  }
  return Array.from(columns);
}

function collectRequiredSourceColumnsForTableMapping(tableMapping = {}) {
  const columns = new Set();
  for (const column of configuredColumns(tableMapping.rowFilter?.config || {})) addColumn(columns, column);
  for (const column of expressionColumns(tableMapping.rowFilter?.expression)) addColumn(columns, column);

  for (const mapping of tableMapping.columnMappings || []) {
    if (mapping.enabled === false) continue;
    if (mapping.targetColumnMode === 'ignore') continue;
    if (!mapping.targetColumn) continue;
    for (const column of collectTransformSourceColumns(mapping.transform, mapping.sourceColumn)) addColumn(columns, column);
  }
  return Array.from(columns);
}

function lookupSpecFromTransform(transform, fallbackSourceColumn) {
  const rule = normalizeTransform(transform);
  if (rule.type !== 'lookup_table') return null;
  const config = rule.config || {};
  const table = String(config.table || '').trim();
  const lookupColumn = String(config.lookupColumn || '').trim();
  const valueColumn = String(config.valueColumn || '').trim();
  const localColumn = String(config.localColumn || fallbackSourceColumn || '').trim();
  if (!table || !lookupColumn || !valueColumn || !localColumn) return null;
  return {
    table,
    localColumn,
    lookupColumn,
    valueColumn,
    missing: String(config.missing || 'reject'),
    defaultValue: config.defaultValue,
  };
}

function lookupSpecKey(spec = {}) {
  return stableHash(sortedObject({
    table: spec.table,
    localColumn: spec.localColumn,
    lookupColumn: spec.lookupColumn,
    valueColumn: spec.valueColumn,
  }));
}

function collectLookupDependencies(tableMapping = {}) {
  const byKey = new Map();
  for (const mapping of tableMapping.columnMappings || []) {
    if (mapping.enabled === false || mapping.targetColumnMode === 'ignore' || !mapping.targetColumn) continue;
    const spec = lookupSpecFromTransform(mapping.transform, mapping.sourceColumn);
    if (!spec) continue;
    const key = lookupSpecKey(spec);
    byKey.set(key, { key, ...spec, targetColumn: mapping.targetColumn, sourceColumn: mapping.sourceColumn });
  }
  return Array.from(byKey.values());
}

async function defaultLookupRowsForSpec({ sourceConnection, sourceSession, schema, spec, keys }) {
  if (!keys.length) return [];
  const resolvedSource = normalizeMysqlConnection(sourceConnection || {});
  const safeSchema = quoteMysqlIdentifier(schema || resolvedSource.database || sourceSession?.database);
  const safeTable = quoteMysqlIdentifier(spec.table);
  const lookupColumn = quoteMysqlIdentifier(spec.lookupColumn);
  const valueColumn = quoteMysqlIdentifier(spec.valueColumn);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `SELECT ${lookupColumn} AS lookup_key, ${valueColumn} AS lookup_value FROM ${safeSchema}.${safeTable} WHERE ${lookupColumn} IN (${placeholders})`;
  if (sourceSession) return runMysqlSessionQuery(sourceSession, sql, keys);
  return runMysqlQuery(resolvedSource, sql, keys, { database: schema || resolvedSource.database });
}

async function prepareLookupCaches({ rows, tableMapping, sourceConnection, sourceSession, schema, lookupRowsForSpec }) {
  const caches = new Map();
  const dependencies = collectLookupDependencies(tableMapping);
  const fetcher = lookupRowsForSpec || defaultLookupRowsForSpec;
  for (const spec of dependencies) {
    const keys = Array.from(new Set((rows || []).map((row) => row?.[spec.localColumn]).filter((value) => value != null && value !== '').map(String)));
    const lookupRows = await fetcher({ sourceConnection, sourceSession, schema, spec, keys });
    const cache = new Map();
    for (const row of lookupRows || []) {
      const key = row.lookup_key ?? row[spec.lookupColumn];
      const value = row.lookup_value ?? row[spec.valueColumn];
      if (key != null && !cache.has(String(key))) cache.set(String(key), value);
    }
    caches.set(spec.key, cache);
  }
  return { caches, dependencies };
}

function createLookupResolver(caches) {
  return ({ config, sourceRow, value }) => {
    const spec = lookupSpecFromTransform({ type: 'lookup_table', config }, config.localColumn);
    if (!spec) return { found: false, value: null };
    const localValue = sourceRow?.[spec.localColumn] ?? value;
    if (localValue == null || localValue === '') return { found: false, value: null };
    const cache = caches.get(lookupSpecKey(spec));
    if (!cache) return { found: false, value: null };
    if (!cache.has(String(localValue))) return { found: false, value: null };
    return { found: true, value: cache.get(String(localValue)) };
  };
}

async function transformRowsForTable({ rows, tableMapping, sourceConnection, sourceSession, schema, lookupRowsForSpec }) {
  const { caches, dependencies } = await prepareLookupCaches({ rows, tableMapping, sourceConnection, sourceSession, schema, lookupRowsForSpec });
  const lookupResolver = createLookupResolver(caches);
  const transformedRows = [];
  const rejected = [];
  let filteredRowCount = 0;

  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = rows[index];
    try {
      const transformed = transformRow({ row, tableMapping, lookupResolver });
      if (transformed == null) {
        filteredRowCount += 1;
      } else {
        transformedRows.push(transformed);
      }
    } catch (error) {
      rejected.push({ index, row, error });
    }
  }

  return { transformedRows, filteredRowCount, rejected, lookupDependencies: dependencies };
}

function validateTableTransforms(tableMapping = {}, sampleRow = {}) {
  const warnings = [];
  for (const columnMapping of tableMapping.columnMappings || []) {
    if (columnMapping.enabled === false || columnMapping.targetColumnMode === 'ignore') continue;
    try {
      validateTransformRule(columnMapping.transform, {
        value: sampleRow?.[columnMapping.sourceColumn],
        row: sampleRow || {},
      });
    } catch (error) {
      warnings.push({
        kind: 'transform_rule_invalid',
        sourceColumn: columnMapping.sourceColumn,
        targetColumn: columnMapping.targetColumn || '',
        message: error.message || String(error),
      });
    }
  }
  try {
    shouldIncludeRow({ row: sampleRow || {}, tableMapping });
  } catch (error) {
    warnings.push({ kind: 'row_filter_invalid', message: error.message || String(error) });
  }
  return warnings;
}

function normalizePreviewScope({ mode = 'all', selectedTables = [], sampleLimit = 5, loadPhase = 'configured' } = {}) {
  const normalizedMode = mode === 'selected' ? 'selected' : 'all';
  const normalizedSelectedTables = normalizedMode === 'selected'
    ? Array.from(new Set((selectedTables || []).map((item) => String(item || '').trim()).filter(Boolean))).sort()
    : [];
  return {
    mode: normalizedMode,
    selectedTables: normalizedSelectedTables,
    sampleLimit: Number(sampleLimit || 5),
    loadPhase: loadPhase || 'configured',
  };
}

async function buildTransformPreview({ project, sampleSourceRows, sampleLimit = 5, mode = 'all', selectedTables = [], loadPhase = 'configured', sourceConnection, lookupRowsForSpec }) {
  const scope = normalizePreviewScope({ mode, selectedTables, sampleLimit, loadPhase });
  const selected = scope.mode === 'selected' ? new Set(scope.selectedTables) : null;
  const tables = [];
  const projectTransformFingerprint = transformFingerprint(project);
  for (const mapping of (project.tableMappings || []).filter((item) => item.enabled !== false && (!selected || selected.has(item.sourceTable)))) {
    const requiredColumns = collectRequiredSourceColumnsForTableMapping(mapping);
    const sampleRows = await sampleSourceRows(mapping.sourceTable, sampleLimit, mapping, { columns: requiredColumns.length ? requiredColumns : ['*'] });
    const warnings = validateTableTransforms(mapping, sampleRows[0] || {});
    let outcome = { transformedRows: [], filteredRowCount: 0, rejected: [], lookupDependencies: collectLookupDependencies(mapping) };
    try {
      outcome = await transformRowsForTable({
        rows: sampleRows,
        tableMapping: mapping,
        sourceConnection,
        schema: project.sourceSchema,
        lookupRowsForSpec,
      });
    } catch (error) {
      outcome.rejected = [{ index: -1, row: null, error }];
    }
    const transformErrors = outcome.rejected.map((item) => ({
      index: item.index,
      message: item.error?.message || String(item.error),
      row: item.row || null,
    }));
    const status = transformErrors.length ? 'error' : (warnings.length ? 'review' : 'ready');
    tables.push({
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      status,
      requiredColumns,
      rowFilter: mapping.rowFilter || null,
      lookupDependencies: outcome.lookupDependencies || [],
      warnings,
      sampleRows,
      transformedRows: outcome.transformedRows,
      filteredRowCount: outcome.filteredRowCount,
      transformErrors,
    });
  }

  const summary = {
    tableCount: tables.length,
    readyCount: tables.filter((table) => table.status === 'ready').length,
    reviewCount: tables.filter((table) => table.status === 'review').length,
    errorCount: tables.filter((table) => table.status === 'error').length,
    transformedSampleRows: tables.reduce((sum, table) => sum + (table.transformedRows || []).length, 0),
    filteredSampleRows: tables.reduce((sum, table) => sum + (table.filteredRowCount || 0), 0),
    transformErrorCount: tables.reduce((sum, table) => sum + (table.transformErrors || []).length, 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    transformFingerprint: projectTransformFingerprint,
    scope,
    summary,
    tables,
  };
}

module.exports = {
  buildTransformPreview,
  collectLookupDependencies,
  collectRequiredSourceColumnsForTableMapping,
  collectTransformSourceColumns,
  normalizePreviewScope,
  transformFingerprint,
  transformRowsForTable,
  validateTableTransforms,
};
