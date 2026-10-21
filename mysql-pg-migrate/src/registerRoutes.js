const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { requireToolDep } = require('../requireToolDep');

const express = requireToolDep('express');
const { z } = requireToolDep('zod');

const { createPersistence } = require('./state/persistence');
const { introspectMysqlSchema, listMysqlSchemas, sampleMysqlTableRows, countMysqlRows, countMysqlColumnNulls, normalizeMysqlConnection } = require('./lib/mysqlIntrospector');
const { introspectPostgresSchema, listPostgresSchemas, samplePostgresTableRows, buildProvisioningPlan, createTargetTables, countPostgresRows } = require('./lib/postgresIntrospector');
const { analyzePreflight, buildDryRunPreview, validateRunReport } = require('./lib/preflight');
const { createExecutionEngine } = require('./lib/executionEngine');
const { listTransformPresets } = require('./lib/transformCatalog');
const { buildTransformPreview, collectRequiredSourceColumnsForTableMapping, normalizePreviewScope, transformFingerprint, transformRowsForTable } = require('./lib/transformEngine');
const { replayCorrectedRows } = require('./lib/replayEngine');
const { buildCutoverReadinessReport } = require('./lib/reporting');
const { buildVerificationPayload } = require('./lib/verification');

const ROOT_DIR = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT_DIR, 'state');
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

const persistence = createPersistence({ rootDir: STATE_DIR });
const executionEngine = createExecutionEngine({ persistence });
const runStreams = new Map();
const runControls = new Map();
const MASKED_CONNECTION_STRING = '[provided]';

function getRunChannel(runId) {
  let channel = runStreams.get(runId);
  if (!channel) {
    channel = { listeners: new Set() };
    runStreams.set(runId, channel);
  }
  return channel;
}

function publishRunEvent(runId, event, data) {
  const channel = getRunChannel(runId);
  for (const res of Array.from(channel.listeners)) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      channel.listeners.delete(res);
    }
  }
}

function createRunControl(runId) {
  const control = { cancelled: false };
  runControls.set(runId, control);
  return control;
}

async function saveTerminalRunStatus(runId, error) {
  const existing = (await persistence.getRun(runId)) || { id: runId };
  const cancelled = error?.code === 'RUN_CANCELLED';
  await persistence.saveRun({
    ...existing,
    status: cancelled ? 'cancelled' : 'error',
    error: error?.message || String(error),
    updatedAt: new Date().toISOString(),
  });
  publishRunEvent(runId, 'log', { level: cancelled ? 'warn' : 'error', message: error?.message || String(error) });
  publishRunEvent(runId, 'status', { status: cancelled ? 'cancelled' : 'error' });
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function redactPreviewRowsForPersistence(report) {
  const clone = JSON.parse(JSON.stringify(report || {}));
  for (const table of clone.tables || clone.previews || []) {
    if (Array.isArray(table.sampleRows)) {
      table.sampleRowCount = table.sampleRows.length;
      table.sampleRows = '[redacted]';
    }
    if (Array.isArray(table.transformedRows)) {
      table.transformedRowCount = table.transformedRows.length;
      table.transformedRows = '[redacted]';
    }
    for (const error of table.transformErrors || []) {
      if (Object.prototype.hasOwnProperty.call(error, 'row')) error.row = '[redacted]';
    }
  }
  clone.redacted = {
    sampleRows: true,
    transformedRows: true,
    reason: 'Preview reports redact row payloads when persisted; the API response still contains the live preview.',
  };
  return clone;
}

function summarizeConnectionRefs(projectLike) {
  return {
    source: projectLike.sourceConnection?.ref || null,
    target: projectLike.targetConnection?.ref || null,
  };
}

const MysqlConnectionSchema = z.object({
  ref: z.string().optional(),
  host: z.string().optional().default(''),
  port: z.coerce.number().int().positive().default(3306),
  user: z.string().optional().default(''),
  password: z.string().optional(),
  database: z.string().optional().default(''),
  sslMode: z.string().default('PREFERRED'),
  sslCa: z.string().optional(),
  sslCert: z.string().optional(),
  sslKey: z.string().optional(),
  connectionString: z.string().optional(),
  consistentRead: z.object({
    enabled: z.boolean().default(false),
    isolation: z.enum(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']).default('REPEATABLE READ'),
  }).optional(),
});

const PostgresConnectionSchema = z.object({
  ref: z.string().optional(),
  connectionString: z.string().optional(),
  pooler: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().positive().default(5432),
    user: z.string().min(1),
    database: z.string().min(1),
    password: z.string().optional(),
    sslmode: z.enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']).default('prefer'),
  }).optional(),
});

const ContextSchema = z.object({
  sourceConnection: MysqlConnectionSchema,
  targetConnection: PostgresConnectionSchema,
  sourceSchema: z.string().min(1).default('<SOURCE_SCHEMA>'),
  targetSchema: z.string().min(1).default('<TARGET_SCHEMA>'),
  includeViews: z.boolean().default(false),
});

const ProjectCreateSchema = ContextSchema.extend({
  name: z.string().min(1),
});

const TransformRuleSchema = z.object({
  type: z.string(),
  preset: z.string().optional(),
  config: z.record(z.string(), z.any()).default({}),
});

const RowFilterSchema = z.object({
  enabled: z.boolean().default(false),
  expression: z.string().default(''),
  config: z.record(z.string(), z.any()).default({}),
});

const SourceFilterSchema = z.object({
  enabled: z.boolean().default(false),
  column: z.string().default(''),
  operator: z.enum(['=', '!=', '>', '>=', '<', '<=', 'between', 'like', 'is_null', 'is_not_null']).default('>='),
  value: z.any().optional(),
  valueTo: z.any().optional(),
});

const LoadStrategySchema = z.object({
  mode: z.enum(['historical_full', 'historical_filtered', 'incremental_watermark', 'historical_then_incremental']).default('historical_full'),
  historicalFilter: SourceFilterSchema.optional(),
  watermarkColumn: z.string().optional(),
  tieBreakerColumn: z.string().optional(),
  baselineWatermark: z.any().optional(),
  baselineTieBreaker: z.any().optional(),
  lookbackAmount: z.coerce.number().nonnegative().default(0).optional(),
  lookbackUnit: z.enum(['minutes', 'hours', 'days']).default('minutes').optional(),
  persistWatermark: z.boolean().default(true).optional(),
  deleteHandling: z.object({
    mode: z.enum(['none', 'soft_delete']).default('none'),
    column: z.string().optional(),
  }).optional(),
}).optional();

const ColumnMappingSchema = z.object({
  id: z.string(),
  sourceColumn: z.string(),
  targetColumn: z.string().nullable().optional(),
  targetColumnMode: z.enum(['existing', 'create_new', 'ignore']).optional(),
  transform: TransformRuleSchema.default({ type: 'direct', config: {} }),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});

const TableMappingSchema = z.object({
  id: z.string(),
  sourceTable: z.string(),
  targetTable: z.string().nullable().optional(),
  targetTableMode: z.enum(['existing', 'create_new']).default('existing').optional(),
  createTargetTable: z.boolean().default(false).optional(),
  enabled: z.boolean().default(true),
  conflictStrategy: z.enum(['insert', 'upsert', 'truncate-load']).default('insert'),
  conflictKeys: z.array(z.string()).default([]),
  chunkSize: z.coerce.number().int().positive().default(500),
  watermarkColumn: z.string().optional(),
  loadStrategy: LoadStrategySchema,
  rowFilter: RowFilterSchema.optional(),
  writeMode: z.enum(['append', 'truncate', 'upsert']).default('append'),
  order: z.coerce.number().int().default(0),
  columnMappings: z.array(ColumnMappingSchema).default([]),
});

const AllowedVerificationIssueSchema = z.object({
  issueKey: z.string().min(1),
  kind: z.string().min(1),
  sourceTable: z.string().optional().default(''),
  targetTable: z.string().optional().default(''),
  sourceColumn: z.string().optional().default(''),
  targetColumn: z.string().optional().default(''),
  reason: z.string().trim().min(1),
  allowedAt: z.string().optional(),
});

const ProjectImportSchema = z.object({
  id: z.string().regex(SAFE_ID_RE, 'Project id may contain only letters, numbers, underscores, and hyphens').optional(),
  name: z.string().min(1),
  notes: z.string().optional(),
  sourceConnection: MysqlConnectionSchema.optional(),
  targetConnection: PostgresConnectionSchema.optional(),
  sourceSchema: z.string().optional(),
  targetSchema: z.string().optional(),
  includeViews: z.boolean().optional(),
  tableMappings: z.array(TableMappingSchema).default([]),
  sourceCatalog: z.any().optional(),
  targetCatalog: z.any().optional(),
  allowedVerificationIssues: z.array(AllowedVerificationIssueSchema).optional(),
  versions: z.array(z.any()).optional(),
  schemaVersion: z.coerce.number().int().default(2),
});

const ProjectUpdateSchema = z.object({
  name: z.string().optional(),
  tableMappings: z.array(TableMappingSchema).optional(),
  notes: z.string().optional(),
  sourceSchema: z.string().optional(),
  targetSchema: z.string().optional(),
  includeViews: z.boolean().optional(),
  sourceCatalog: z.any().optional(),
  targetCatalog: z.any().optional(),
});

const VerificationAllowancesUpdateSchema = z.object({
  allowedVerificationIssues: z.array(AllowedVerificationIssueSchema).default([]),
});

const ExecuteSchema = z.object({
  mode: z.enum(['all', 'selected']).default('all'),
  selectedTables: z.array(z.string()).default([]),
  dryRun: z.boolean().default(false),
  confirmationFingerprint: z.string().optional(),
  errorPolicy: z.enum(['fail-fast', 'quarantine']).default('fail-fast'),
  concurrency: z.coerce.number().int().positive().default(1),
  batchSize: z.coerce.number().int().positive().default(1000),
  cdcMode: z.enum(['off', 'snapshot-only', 'watermark']).default('off'),
  loadPhase: z.enum(['configured', 'historical', 'incremental']).default('configured'),
  cutoverMode: z.enum(['manual', 'guarded']).default('manual'),
  watermarkColumn: z.string().optional(),
  verificationFingerprint: z.string().optional(),
  transformFingerprint: z.string().optional(),
  sourceConnection: MysqlConnectionSchema.optional(),
  targetConnection: PostgresConnectionSchema.optional(),
});

const TransformPreviewSchema = z.object({
  mode: z.enum(['all', 'selected']).default('all').optional(),
  selectedTables: z.array(z.string()).default([]).optional(),
  sampleLimit: z.coerce.number().int().positive().max(50).default(5).optional(),
  loadPhase: z.enum(['configured', 'historical', 'incremental']).default('configured').optional(),
  sourceConnection: MysqlConnectionSchema.optional(),
});

function resolveRuntimeConnections(project, overrides = {}) {
  return {
    sourceConnection: normalizeMysqlConnection(overrides.sourceConnection || project.runtimeSourceConnection || project.sourceConnection),
    targetConnection: overrides.targetConnection || project.runtimeTargetConnection || project.targetConnection,
  };
}

function hasMysqlPassword(connection) {
  const norm = normalizeMysqlConnection(connection);
  return norm?.password !== undefined && norm?.password !== null;
}

function ensureMysqlPassword(connection, res) {
  const normalized = normalizeMysqlConnection(connection);
  const missing = ['host', 'user', 'database'].filter((key) => !String(normalized?.[key] || '').trim());
  if (missing.length) {
    res.status(400).json({ ok: false, error: `Missing source MySQL connection field(s): ${missing.join(', ')}` });
    return false;
  }
  if (hasMysqlPassword(normalized)) return true;
  res.status(400).json({ ok: false, error: 'Source MySQL password is required' });
  return false;
}

function hasPostgresCredentials(connection) {
  const connectionString = String(connection?.connectionString || '').trim();
  if (connectionString && connectionString !== MASKED_CONNECTION_STRING) return true;
  if (connection?.pooler?.password !== undefined && connection?.pooler?.password !== null) return true;
  return false;
}

function applyWatermarkLookback(value, strategy = {}) {
  const amount = Number(strategy.lookbackAmount || 0);
  if (!amount || value == null) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const unit = strategy.lookbackUnit || 'minutes';
  const multiplier = unit === 'days' ? 86400000 : unit === 'hours' ? 3600000 : 60000;
  return new Date(date.getTime() - amount * multiplier).toISOString();
}

function buildSampleOptionsForMapping(mapping = {}, { watermarks, loadPhase = 'configured' } = {}) {
  const strategy = mapping.loadStrategy || { mode: 'historical_full' };
  const state = watermarks?.tables?.[mapping.sourceTable] || {};
  let effectiveMode = strategy.mode || 'historical_full';
  if (loadPhase === 'historical') {
    effectiveMode = strategy.mode === 'historical_filtered' || (strategy.mode === 'historical_then_incremental' && strategy.historicalFilter?.enabled) ? 'historical_filtered' : 'historical_full';
  } else if (loadPhase === 'incremental') {
    effectiveMode = 'incremental_watermark';
  } else if (effectiveMode === 'historical_then_incremental') {
    effectiveMode = state.lastWatermark != null ? 'incremental_watermark' : (strategy.historicalFilter?.enabled ? 'historical_filtered' : 'historical_full');
  }

  const sourceFilter = effectiveMode === 'historical_filtered' && strategy.historicalFilter?.enabled ? strategy.historicalFilter : undefined;
  const watermarkColumn = strategy.watermarkColumn || mapping.watermarkColumn || state.watermarkColumn || null;
  const tieBreakerColumn = strategy.tieBreakerColumn || state.tieBreakerColumn || null;
  const watermarkValue = applyWatermarkLookback(state.lastWatermark ?? strategy.baselineWatermark ?? null, strategy);
  const tieBreakerValue = state.lastTieBreaker ?? strategy.baselineTieBreaker ?? null;
  const keyset = effectiveMode === 'incremental_watermark' && watermarkColumn
    ? { watermarkColumn, watermarkValue, tieBreakerColumn, tieBreakerValue }
    : undefined;
  return { sourceFilter, keyset };
}

function ensurePostgresPassword(connection, res) {
  if (hasPostgresCredentials(connection)) return true;
  res.status(400).json({ ok: false, error: 'Target PostgreSQL password or connection string is required' });
  return false;
}

function transformPreviewScopeCoversRun(previewScope, executionOptions = {}) {
  if (!previewScope) return false;
  const preview = normalizePreviewScope(previewScope);
  const run = normalizePreviewScope({
    mode: executionOptions.mode || 'all',
    selectedTables: executionOptions.selectedTables || [],
    loadPhase: executionOptions.loadPhase || 'configured',
    sampleLimit: preview.sampleLimit || 5,
  });
  if (preview.loadPhase !== run.loadPhase) return false;
  if (run.mode === 'all') return preview.mode === 'all';
  if (preview.mode === 'all') return true;
  const previewTables = new Set(preview.selectedTables || []);
  return (run.selectedTables || []).every((table) => previewTables.has(table));
}

async function findTransformPreviewReport({ projectId, fingerprint: expectedFingerprint, executionOptions }) {
  if (typeof persistence.listReports !== 'function') return null;
  const reports = await persistence.listReports(projectId, 'transform-preview');
  return reports.find((report) => {
    const preview = report.report || {};
    return preview.transformFingerprint === expectedFingerprint && transformPreviewScopeCoversRun(preview.scope, executionOptions);
  }) || null;
}

function scopeProjectForExecution(project, executionOptions = {}) {
  if (executionOptions.mode !== 'selected') return project;
  const selected = new Set(executionOptions.selectedTables || []);
  return {
    ...project,
    tableMappings: (project.tableMappings || []).filter((mapping) => selected.has(mapping.sourceTable)),
  };
}

async function buildVerificationForProject({ project, runtime, executionOptions = { mode: 'all', selectedTables: [] } }) {
  const scopedProject = scopeProjectForExecution(project, executionOptions);
  const schemaPlan = buildProvisioningPlan({
    sourceCatalog: scopedProject.sourceCatalog,
    targetCatalog: scopedProject.targetCatalog,
    targetSchema: scopedProject.targetSchema,
    tableMappings: scopedProject.tableMappings || [],
  });
  const report = await analyzePreflight({
    project: scopedProject,
    schemaPlan,
    sampleSourceRows: async (tableName, limit) => sampleMysqlTableRows(runtime.sourceConnection, project.sourceSchema, tableName, limit || 10),
    countSourceNulls: async (tableName, columnName) => countMysqlColumnNulls(runtime.sourceConnection, project.sourceSchema, tableName, columnName),
    transformSampleRows: async (mapping, rows) => transformSampleRowsForMapping({ project, runtime, mapping, rows }),
  });
  const pendingSchemaActions = schemaPlan.tables.filter((table) => ['create_table', 'alter_table_add_columns'].includes(table.action));
  const blockingSchemaIssues = schemaPlan.tables.filter((table) => ['missing_target_table', 'target_name_conflict', 'manual_fix_required'].includes(table.action) || (table.issues || []).length > 0);
  const executionPlan = executionEngine.buildExecutionPlan(scopedProject, executionOptions || { mode: 'all', selectedTables: [] });
  return buildVerificationPayload({ project: scopedProject, report, schemaPlan, pendingSchemaActions, blockingSchemaIssues, executionPlan });
}

async function transformSampleRowsForMapping({ project, runtime, mapping, rows }) {
  return transformRowsForTable({
    rows,
    tableMapping: mapping,
    sourceConnection: runtime.sourceConnection,
    schema: project.sourceSchema,
  });
}

function rejectIfVerificationNotReady(res, verification) {
  if (verification.readyToLoad) return false;
  const first = (verification.issues || []).find((issue) => issue.severity === 'blocker' && issue.status !== 'allowed');
  const schemaIssue = (verification.hardBlockingSchemaIssues || [])[0] || (verification.pendingSchemaActions || [])[0];
  const reason = first?.message || (schemaIssue ? `Target schema action required for ${schemaIssue.targetTable || schemaIssue.sourceTable || 'a table'}.` : 'Verification has unresolved blockers.');
  res.status(409).json({
    ok: false,
    error: reason,
    verification: {
      verificationFingerprint: verification.verificationFingerprint,
      openBlockerCount: verification.openBlockerCount,
      allowedBlockerCount: verification.allowedBlockerCount,
      nonAllowableBlockerCount: verification.nonAllowableBlockerCount,
      warningCount: verification.warningCount,
      readyToLoad: verification.readyToLoad,
    },
  });
  return true;
}

function registerMysqlPgMigrateRoutes(app, { basePath = '/api/tools/mysql-pg-migrate' } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  router.get('/health', async (_req, res) => {
    res.json({ ok: true, tool: 'mysql-pg-migrate' });
  });

  router.get('/transforms/catalog', async (_req, res) => {
    res.json({ ok: true, transforms: listTransformPresets() });
  });

  router.post('/connections/source/schemas', async (req, res) => {
    const parsed = z.object({ sourceConnection: MysqlConnectionSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    if (!ensureMysqlPassword(parsed.data.sourceConnection, res)) return;
    try {
      const schemas = await listMysqlSchemas(parsed.data.sourceConnection);
      res.json({ ok: true, schemas });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/connections/target/schemas', async (req, res) => {
    const parsed = z.object({ targetConnection: PostgresConnectionSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    if (!ensurePostgresPassword(parsed.data.targetConnection, res)) return;
    try {
      const schemas = await listPostgresSchemas(parsed.data.targetConnection);
      res.json({ ok: true, schemas });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/introspect', async (req, res) => {
    const parsed = ContextSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const ctx = parsed.data;
    if (!ensureMysqlPassword(ctx.sourceConnection, res)) return;
    if (!ensurePostgresPassword(ctx.targetConnection, res)) return;
    try {
      const source = await introspectMysqlSchema(ctx.sourceConnection, { schema: ctx.sourceSchema, includeViews: ctx.includeViews });
      const target = await introspectPostgresSchema(ctx.targetConnection, { schema: ctx.targetSchema, includeViews: ctx.includeViews });
      res.json({
        ok: true,
        source,
        target,
        fingerprints: {
          source: fingerprint(source),
          target: fingerprint(target),
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/projects', async (req, res) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const payload = parsed.data;
    if (!ensureMysqlPassword(payload.sourceConnection, res)) return;
    if (!ensurePostgresPassword(payload.targetConnection, res)) return;
    try {
      const sourceConnection = normalizeMysqlConnection(payload.sourceConnection);
      const sourceCatalog = await introspectMysqlSchema(sourceConnection, { schema: payload.sourceSchema, includeViews: payload.includeViews });
      const targetCatalog = await introspectPostgresSchema(payload.targetConnection, { schema: payload.targetSchema, includeViews: payload.includeViews });
      const project = await persistence.saveProject({
        id: makeId('project'),
        name: payload.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceConnection: { ...sourceConnection, password: undefined, sslKey: undefined, connectionString: '', ref: sourceConnection.ref || sourceConnection.database || 'source' },
        targetConnection: { ...payload.targetConnection, connectionString: '', pooler: payload.targetConnection.pooler ? { ...payload.targetConnection.pooler, password: undefined } : undefined, ref: payload.targetConnection.ref || summarizeConnectionRefs({ targetConnection: payload.targetConnection }).target || payload.targetConnection.pooler?.database || 'target' },
        sourceSchema: payload.sourceSchema,
        targetSchema: payload.targetSchema,
        includeViews: payload.includeViews,
        sourceFingerprint: fingerprint(sourceCatalog),
        targetFingerprint: fingerprint(targetCatalog),
        sourceCatalog,
        targetCatalog,
        tableMappings: [],
        allowedVerificationIssues: [],
        mappingSummary: {
          mode: 'manual',
          sourceTables: sourceCatalog.tables?.length || 0,
          targetTables: targetCatalog.tables?.length || 0,
          mappedTables: 0,
        },
        versions: [{ createdAt: new Date().toISOString(), tableMappings: [] }],
      });
      res.json({ ok: true, project });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.get('/projects', async (_req, res) => {
    const projects = await persistence.listProjects();
    res.json({ ok: true, projects });
  });

  router.get('/projects/:id', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    res.json({ ok: true, project });
  });

  router.put('/projects/:id', async (req, res) => {
    const parsed = ProjectUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const existing = await persistence.getProject(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Project not found' });
    const next = {
      ...existing,
      ...parsed.data,
      updatedAt: new Date().toISOString(),
      versions: [
        ...(existing.versions || []),
        { createdAt: new Date().toISOString(), tableMappings: parsed.data.tableMappings || existing.tableMappings },
      ],
    };
    const project = await persistence.saveProject(next);
    res.json({ ok: true, project });
  });

  router.put('/projects/:id/verification-allowances', async (req, res) => {
    const parsed = VerificationAllowancesUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const existing = await persistence.getProject(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Project not found' });
    const now = new Date().toISOString();
    const seen = new Set();
    const allowedVerificationIssues = [];
    for (const item of parsed.data.allowedVerificationIssues || []) {
      if (seen.has(item.issueKey)) continue;
      seen.add(item.issueKey);
      allowedVerificationIssues.push({
        issueKey: item.issueKey,
        kind: item.kind,
        sourceTable: item.sourceTable || '',
        targetTable: item.targetTable || '',
        sourceColumn: item.sourceColumn || '',
        targetColumn: item.targetColumn || '',
        reason: item.reason.trim(),
        allowedAt: item.allowedAt || now,
      });
    }
    const project = await persistence.saveProject({
      ...existing,
      allowedVerificationIssues,
      updatedAt: now,
    });
    res.json({ ok: true, project });
  });

  router.post('/projects/:id/preflight', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
      if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
      const schemaPlan = buildProvisioningPlan({
        sourceCatalog: project.sourceCatalog,
        targetCatalog: project.targetCatalog,
        targetSchema: project.targetSchema,
        tableMappings: project.tableMappings || [],
      });
      const report = await analyzePreflight({
        project,
        schemaPlan,
        sampleSourceRows: async (tableName, limit) => sampleMysqlTableRows(runtime.sourceConnection, project.sourceSchema, tableName, limit || 10),
        countSourceNulls: async (tableName, columnName) => countMysqlColumnNulls(runtime.sourceConnection, project.sourceSchema, tableName, columnName),
        transformSampleRows: async (mapping, rows) => transformSampleRowsForMapping({ project, runtime, mapping, rows }),
      });
      await persistence.saveReport({ id: makeId('preflight'), projectId: project.id, type: 'preflight', createdAt: new Date().toISOString(), report });
      res.json({ ok: true, report, fingerprint: fingerprint(report) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/projects/:id/schema-plan', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const plan = buildProvisioningPlan({
        sourceCatalog: project.sourceCatalog,
        targetCatalog: project.targetCatalog,
        targetSchema: project.targetSchema,
        tableMappings: project.tableMappings || [],
      });
      res.json({ ok: true, plan });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.get('/projects/:id/watermarks', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const watermarks = await persistence.getWatermarks(project.id) || { projectId: project.id, tables: {} };
    res.json({ ok: true, watermarks });
  });

  router.put('/projects/:id/watermarks/:tableName', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const tableName = req.params.tableName;
    const patch = {
      watermarkColumn: req.body?.watermarkColumn || null,
      tieBreakerColumn: req.body?.tieBreakerColumn || null,
      lastWatermark: req.body?.lastWatermark ?? null,
      lastTieBreaker: req.body?.lastTieBreaker ?? null,
      manuallySet: true,
    };
    const watermarks = await persistence.updateTableWatermark(project.id, tableName, patch);
    res.json({ ok: true, watermarks });
  });

  router.delete('/projects/:id/watermarks/:tableName', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const watermarks = await persistence.resetTableWatermark(project.id, req.params.tableName);
    res.json({ ok: true, watermarks });
  });

  router.post('/projects/:id/provision-target', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;
    try {
      const targetConnection = runtime.targetConnection;
      const plan = buildProvisioningPlan({
        sourceCatalog: project.sourceCatalog,
        targetCatalog: project.targetCatalog,
        targetSchema: project.targetSchema,
        tableMappings: project.tableMappings || [],
      });
      const created = await createTargetTables(targetConnection, { schema: project.targetSchema, tables: plan.tables });
      const refreshedTargetCatalog = await introspectPostgresSchema(targetConnection, { schema: project.targetSchema, includeViews: project.includeViews });
      const nextProject = { ...project, targetCatalog: refreshedTargetCatalog, targetFingerprint: fingerprint(refreshedTargetCatalog), updatedAt: new Date().toISOString(), lastProvisioningPlan: plan };
      await persistence.saveProject(nextProject);
      res.json({ ok: true, created, plan, project: nextProject });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/projects/:id/verify', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
      if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
      const verification = await buildVerificationForProject({
        project,
        runtime,
        executionOptions: {
          mode: req.body?.mode === 'selected' ? 'selected' : 'all',
          selectedTables: Array.isArray(req.body?.selectedTables) ? req.body.selectedTables : [],
          dryRun: Boolean(req.body?.dryRun),
          errorPolicy: req.body?.errorPolicy || 'fail-fast',
          concurrency: Number(req.body?.concurrency || 1),
          batchSize: Number(req.body?.batchSize || 1000),
          cdcMode: req.body?.cdcMode || 'off',
          loadPhase: req.body?.loadPhase || 'configured',
          cutoverMode: req.body?.cutoverMode || 'manual',
          watermarkColumn: req.body?.watermarkColumn || undefined,
        },
      });
      res.json({ ok: true, verification });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/projects/:id/transform-preview', async (req, res) => {
    const parsed = TransformPreviewSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const runtime = resolveRuntimeConnections(project, { sourceConnection: parsed.data.sourceConnection });
      if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
      const watermarks = await persistence.getWatermarks(project.id) || { projectId: project.id, tables: {} };
      const previewMode = parsed.data.mode || 'all';
      const selectedTables = previewMode === 'selected' ? (parsed.data.selectedTables || []) : [];
      const loadPhase = parsed.data.loadPhase || 'configured';
      const preview = await buildTransformPreview({
        project,
        mode: previewMode,
        selectedTables,
        sampleLimit: parsed.data.sampleLimit || 5,
        loadPhase,
        sourceConnection: runtime.sourceConnection,
        sampleSourceRows: async (tableName, limit, mapping, extra = {}) => {
          const columns = extra.columns?.length
            ? extra.columns
            : collectRequiredSourceColumnsForTableMapping(mapping);
          return sampleMysqlTableRows(
            runtime.sourceConnection,
            project.sourceSchema,
            tableName,
            limit || 5,
            {
              ...buildSampleOptionsForMapping(mapping, { watermarks, loadPhase: parsed.data.loadPhase || 'configured' }),
              columns: columns.length ? columns : ['*'],
            },
          );
        },
      });
      await persistence.saveReport({ id: makeId('transformpreview'), projectId: project.id, type: 'transform-preview', createdAt: new Date().toISOString(), report: redactPreviewRowsForPersistence(preview) });
      res.json({ ok: true, preview, transformFingerprint: preview.transformFingerprint });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  async function buildCutoverReadinessPayload(req, res) {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project || {}, {
      sourceConnection: req.body?.sourceConnection,
      targetConnection: req.body?.targetConnection,
    });

    const schemaPlan = buildProvisioningPlan({
      sourceCatalog: project.sourceCatalog,
      targetCatalog: project.targetCatalog,
      targetSchema: project.targetSchema,
      tableMappings: project.tableMappings || [],
    });
    const verificationReport = await analyzePreflight({
      project,
      schemaPlan,
      sampleSourceRows: async () => [],
    });
    const verification = {
      report: verificationReport,
      pendingSchemaActions: schemaPlan.tables.filter((table) => ['create_table', 'alter_table_add_columns'].includes(table.action)),
    };
    const runReport = await validateRunReport({
      run,
      persistence,
      project,
      countSourceRows: project && hasMysqlPassword(runtime.sourceConnection) ? async (tableName) => countMysqlRows(runtime.sourceConnection, project.sourceSchema, tableName) : undefined,
      countTargetRows: project && hasPostgresCredentials(runtime.targetConnection) ? async (tableName) => countPostgresRows(runtime.targetConnection, project.targetSchema, tableName) : undefined,
    });
    const cutover = buildCutoverReadinessReport({ verification, runReport, project });
    return res.json({ ok: true, cutover });
  }

  router.get('/runs/:id/cutover-readiness', async (req, res) => {
    return buildCutoverReadinessPayload(req, res);
  });

  router.post('/runs/:id/cutover-readiness', async (req, res) => {
    return buildCutoverReadinessPayload(req, res);
  });

  router.post('/projects/:id/dry-run', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
      if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
      const mode = req.body?.mode === 'selected' ? 'selected' : 'all';
      const selectedTables = mode === 'selected' && Array.isArray(req.body?.selectedTables) ? req.body.selectedTables : [];
      const loadPhase = req.body?.loadPhase || 'configured';
      const verification = await buildVerificationForProject({ project, runtime, executionOptions: { ...(req.body || {}), mode, selectedTables, loadPhase } });
      if (rejectIfVerificationNotReady(res, verification)) return;
      const watermarks = await persistence.getWatermarks(project.id) || { projectId: project.id, tables: {} };
      const preview = await buildDryRunPreview({
        project,
        mode,
        selectedTables,
        sampleLimit: Number(req.body?.sampleLimit || 5),
        loadPhase,
        sampleSourceRows: async (tableName, limit, mapping) => sampleMysqlTableRows(
          runtime.sourceConnection,
          project.sourceSchema,
          tableName,
          limit || 5,
          {
            ...buildSampleOptionsForMapping(mapping, { watermarks, loadPhase }),
            columns: collectRequiredSourceColumnsForTableMapping(mapping),
          },
        ),
        transformSampleRows: async (mapping, rows) => transformSampleRowsForMapping({ project, runtime, mapping, rows }),
      });
      await persistence.saveReport({ id: makeId('dryrun'), projectId: project.id, type: 'dry-run', createdAt: new Date().toISOString(), report: redactPreviewRowsForPersistence(preview) });
      res.json({ ok: true, preview });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.post('/projects/:id/execute', async (req, res) => {
    const parsed = ExecuteSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project, parsed.data);
    if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;

    const initialPlan = executionEngine.buildExecutionPlan(project, parsed.data);
    if (!initialPlan.orderedMappings.length) {
      return res.status(400).json({ ok: false, error: 'No enabled table mappings are selected for execution.' });
    }

    const verification = await buildVerificationForProject({ project, runtime, executionOptions: parsed.data });
    if (!parsed.data.verificationFingerprint || parsed.data.verificationFingerprint !== verification.verificationFingerprint) {
      return res.status(409).json({
        ok: false,
        error: 'Verification is stale. Re-run verification before execution.',
        verification: {
          verificationFingerprint: verification.verificationFingerprint,
          openBlockerCount: verification.openBlockerCount,
          allowedBlockerCount: verification.allowedBlockerCount,
          nonAllowableBlockerCount: verification.nonAllowableBlockerCount,
          warningCount: verification.warningCount,
          readyToLoad: verification.readyToLoad,
        },
      });
    }
    if (rejectIfVerificationNotReady(res, verification)) return;

    const currentTransformFingerprint = transformFingerprint(project);
    if (!parsed.data.transformFingerprint || parsed.data.transformFingerprint !== currentTransformFingerprint) {
      return res.status(409).json({
        ok: false,
        error: 'Transform preview is stale. Run the Transform preview before execution.',
        transform: {
          transformFingerprint: currentTransformFingerprint,
        },
      });
    }
    const transformPreviewReport = await findTransformPreviewReport({
      projectId: project.id,
      fingerprint: currentTransformFingerprint,
      executionOptions: parsed.data,
    });
    if (!transformPreviewReport) {
      return res.status(409).json({
        ok: false,
        error: 'Transform preview report is missing or does not match this run scope. Run Transform preview again before execution.',
        transform: {
          transformFingerprint: currentTransformFingerprint,
          requiredScope: normalizePreviewScope({
            mode: parsed.data.mode,
            selectedTables: parsed.data.selectedTables,
            loadPhase: parsed.data.loadPhase,
          }),
        },
      });
    }
    if ((transformPreviewReport.report?.summary?.transformErrorCount || 0) > 0) {
      return res.status(422).json({
        ok: false,
        error: 'Transform preview has errors. Resolve transform errors before execution.',
        transform: {
          transformFingerprint: currentTransformFingerprint,
          errorCount: transformPreviewReport.report.summary.transformErrorCount || 0,
        },
      });
    }

    const runId = makeId('run');
    const runRecord = {
      id: runId,
      projectId: project.id,
      mode: parsed.data.mode,
      selectedTables: parsed.data.selectedTables,
      dryRun: parsed.data.dryRun,
      errorPolicy: parsed.data.errorPolicy,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      counters: {},
      tableStatuses: [],
      executionProfile: {
        mode: parsed.data.mode,
        dryRun: parsed.data.dryRun,
        errorPolicy: parsed.data.errorPolicy,
        selectedTables: parsed.data.selectedTables,
        concurrency: parsed.data.concurrency,
        batchSize: parsed.data.batchSize,
        cdcMode: parsed.data.cdcMode,
        loadPhase: parsed.data.loadPhase,
        cutoverMode: parsed.data.cutoverMode,
        watermarkColumn: parsed.data.watermarkColumn || null,
        consistentRead: runtime.sourceConnection?.consistentRead || { enabled: false },
        consistencyMode: runtime.sourceConnection?.consistentRead?.enabled ? 'table-snapshot' : 'best-effort',
        verificationFingerprint: parsed.data.verificationFingerprint || null,
        transformFingerprint: parsed.data.transformFingerprint || null,
      },
    };
    await persistence.saveRun(runRecord);
    const runControl = createRunControl(runId);
    res.json({ ok: true, runId });

    setImmediate(async () => {
      try {
        publishRunEvent(runId, 'status', { status: 'running' });
        await executionEngine.executeRun({
          runId,
          project: { ...project, runtimeSourceConnection: runtime.sourceConnection, runtimeTargetConnection: runtime.targetConnection },
          options: { ...parsed.data, isCancelled: () => runControl.cancelled },
          publish(event, data) {
            publishRunEvent(runId, event, data);
          },
        });
        const finished = await persistence.getRun(runId);
        publishRunEvent(runId, 'status', { status: finished?.status || 'done' });
      } catch (error) {
        await saveTerminalRunStatus(runId, error);
      } finally {
        runControls.delete(runId);
      }
    });
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    if (run.status === 'cancelling') return res.json({ ok: true, runId: run.id, status: 'cancelling' });
    if (!['queued', 'running'].includes(run.status)) {
      return res.status(409).json({ ok: false, error: `run is ${run.status}` });
    }
    const control = runControls.get(run.id);
    if (control) control.cancelled = true;
    const status = control ? 'cancelling' : 'cancelled';
    await persistence.saveRun({ ...run, status, updatedAt: new Date().toISOString() });
    publishRunEvent(run.id, 'log', { level: 'warn', message: 'Cancellation requested. The current chunk will finish before the run stops.' });
    publishRunEvent(run.id, 'status', { status });
    res.json({ ok: true, runId: run.id, status });
  });

  router.post('/runs/:id/resume', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
    if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;
    const runControl = createRunControl(run.id);
    res.json({ ok: true, runId: run.id, status: 'resume-scheduled' });
    setImmediate(async () => {
      try {
        await executionEngine.resumeRun({
          runId: run.id,
          project: { ...project, runtimeSourceConnection: runtime.sourceConnection, runtimeTargetConnection: runtime.targetConnection },
          options: { isCancelled: () => runControl.cancelled },
          publish(event, data) { publishRunEvent(run.id, event, data); },
        });
        const finished = await persistence.getRun(run.id);
        publishRunEvent(run.id, 'status', { status: finished?.status || 'done' });
      } catch (error) {
        await saveTerminalRunStatus(run.id, error);
      } finally {
        runControls.delete(run.id);
      }
    });
  });

  router.post('/runs/:id/rerun-failed', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const failedTables = (run.tableStatuses || []).filter((table) => table.status === 'error').map((table) => table.tableName);
    if (!failedTables.length) return res.status(400).json({ ok: false, error: 'No failed tables found for this run.' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
    if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;
    const rerunId = makeId('run');
    const rerunOptions = {
      ...(run.executionProfile || {}),
      mode: 'selected',
      selectedTables: failedTables,
      dryRun: false,
      errorPolicy: run.executionProfile?.errorPolicy || run.errorPolicy || 'fail-fast',
    };
    await persistence.saveRun({
      id: rerunId,
      projectId: project.id,
      mode: 'selected',
      selectedTables: failedTables,
      dryRun: false,
      errorPolicy: rerunOptions.errorPolicy,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      counters: {},
      tableStatuses: [],
      rerunOf: run.id,
      executionProfile: {
        ...rerunOptions,
        consistencyMode: run.executionProfile?.consistencyMode || 'best-effort',
      },
    });
    const runControl = createRunControl(rerunId);
    res.json({ ok: true, runId: rerunId, selectedTables: failedTables });
    setImmediate(async () => {
      try {
        await executionEngine.executeRun({
          runId: rerunId,
          project: { ...project, runtimeSourceConnection: runtime.sourceConnection, runtimeTargetConnection: runtime.targetConnection },
          options: { ...rerunOptions, isCancelled: () => runControl.cancelled },
          publish(event, data) {
            publishRunEvent(rerunId, event, data);
          },
        });
        const finished = await persistence.getRun(rerunId);
        publishRunEvent(rerunId, 'status', { status: finished?.status || 'done' });
      } catch (error) {
        await saveTerminalRunStatus(rerunId, error);
      } finally {
        runControls.delete(rerunId);
      }
    });
  });

  router.get('/runs', async (_req, res) => {
    const runs = await persistence.listRuns();
    res.json({ ok: true, runs });
  });

  router.get('/runs/:id', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.json({ ok: true, run });
  });

  async function buildRunReportPayload(req, res) {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    const runtime = resolveRuntimeConnections(project || {}, {
      sourceConnection: req.body?.sourceConnection,
      targetConnection: req.body?.targetConnection,
    });
    const report = await validateRunReport({
      run,
      persistence,
      project,
      countSourceRows: project && hasMysqlPassword(runtime.sourceConnection) ? async (tableName) => countMysqlRows(runtime.sourceConnection, project.sourceSchema, tableName) : undefined,
      countTargetRows: project && hasPostgresCredentials(runtime.targetConnection) ? async (tableName) => countPostgresRows(runtime.targetConnection, project.targetSchema, tableName) : undefined,
    });
    return res.json({ ok: true, report });
  }

  router.get('/runs/:id/report', async (req, res) => {
    return buildRunReportPayload(req, res);
  });

  router.post('/runs/:id/report', async (req, res) => {
    return buildRunReportPayload(req, res);
  });

  router.get('/runs/:id/errors', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const errors = await persistence.listErrors(run.id);
    res.json({ ok: true, errors });
  });

  router.get('/runs/:id/errors/export', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const errors = await persistence.listErrors(run.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${run.id}.errors.json"`);
    res.end(JSON.stringify(errors, null, 2));
  });

  router.post('/runs/:id/replay-errors', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const errors = await persistence.listErrors(run.id);
    const replayable = errors.filter((item) => item.context?.phase === 'write' && item.rowPayload);
    const replayPlan = replayable.map((item) => ({
      errorId: item.id,
      tableName: item.tableName,
      rowPayload: item.rowPayload,
      classification: item.context?.phase === 'write' ? 'write-error' : 'transform-error',
      replayMode: 'manual-correction-required',
    }));
    res.json({ ok: true, replayableCount: replayable.length, replayable, replayPlan, guidance: 'Export errors, correct row payloads offline, then re-import/replay through replay-import with selected corrections.' });
  });

  router.post('/runs/:id/replay-import', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;
    const corrections = Array.isArray(req.body?.corrections) ? req.body.corrections : [];
    const replay = await replayCorrectedRows({
      persistence,
      runId: run.id,
      project,
      targetConnection: runtime.targetConnection,
      sourceConnection: runtime.sourceConnection,
      corrections,
    });
    res.json({ ok: true, replay });
  });

  router.get('/runs/:id/replays', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const replays = await persistence.listReplays(run.id);
    res.json({ ok: true, replays });
  });

  router.get('/runs/:id/events', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).end();
    const channel = getRunChannel(req.params.id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    channel.listeners.add(res);
    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ status: run.status })}\n\n`);

    req.on('close', () => {
      channel.listeners.delete(res);
    });
  });

  router.get('/projects/:id/export', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${project.id}.mapping.json"`);
    res.end(JSON.stringify(project, null, 2));
  });

  router.post('/projects/import', async (req, res) => {
    const parsed = ProjectImportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const payload = parsed.data;
    if (!payload.id) payload.id = makeId('project');
    payload.schemaVersion = payload.schemaVersion || 2;
    payload.allowedVerificationIssues = payload.allowedVerificationIssues || [];
    payload.importedAt = new Date().toISOString();
    payload.updatedAt = new Date().toISOString();
    const project = await persistence.saveProject(payload);
    res.json({ ok: true, project });
  });

  app.use(basePath, router);
  return { router };
}

module.exports = { registerMysqlPgMigrateRoutes };
