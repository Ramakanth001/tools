const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { requireToolDep } = require('../requireToolDep');

const express = requireToolDep('express');
const { z } = requireToolDep('zod');

const { createPersistence } = require('./state/persistence');
const { introspectMysqlSchema, listMysqlSchemas, sampleMysqlTableRows, countMysqlRows } = require('./lib/mysqlIntrospector');
const { introspectPostgresSchema, listPostgresSchemas, samplePostgresTableRows, buildProvisioningPlan, createTargetTables, countPostgresRows } = require('./lib/postgresIntrospector');
const { buildAutoMapping } = require('./lib/autoMapping');
const { analyzePreflight, buildDryRunPreview, validateRunReport } = require('./lib/preflight');
const { createExecutionEngine } = require('./lib/executionEngine');
const { listTransformPresets } = require('./lib/transformCatalog');
const { replayCorrectedRows } = require('./lib/replayEngine');
const { buildCutoverReadinessReport } = require('./lib/reporting');

const ROOT_DIR = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT_DIR, 'state');

const persistence = createPersistence({ rootDir: STATE_DIR });
const executionEngine = createExecutionEngine({ persistence });
const runStreams = new Map();

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

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function summarizeConnectionRefs(projectLike) {
  return {
    source: projectLike.sourceConnection?.ref || null,
    target: projectLike.targetConnection?.ref || null,
  };
}

const MysqlConnectionSchema = z.object({
  ref: z.string().optional(),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().default(3306),
  user: z.string().min(1),
  password: z.string().optional(),
  database: z.string().min(1),
  sslMode: z.string().default('PREFERRED'),
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
    sslmode: z.string().default('require'),
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
  config: z.record(z.any()).default({}),
});

const RowFilterSchema = z.object({
  enabled: z.boolean().default(false),
  expression: z.string().default(''),
  config: z.record(z.any()).default({}),
});

const ColumnMappingSchema = z.object({
  id: z.string(),
  sourceColumn: z.string(),
  targetColumn: z.string().nullable().optional(),
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
  rowFilter: RowFilterSchema.optional(),
  writeMode: z.enum(['append', 'truncate', 'upsert']).default('append'),
  order: z.coerce.number().int().default(0),
  columnMappings: z.array(ColumnMappingSchema).default([]),
});

const ProjectImportSchema = z.object({
  id: z.string().optional(),
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
  autoMappingSummary: z.any().optional(),
  versions: z.array(z.any()).optional(),
  schemaVersion: z.coerce.number().int().default(2),
});

const ProjectUpdateSchema = z.object({
  name: z.string().optional(),
  tableMappings: z.array(TableMappingSchema).optional(),
  notes: z.string().optional(),
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
  cutoverMode: z.enum(['manual', 'guarded']).default('manual'),
  watermarkColumn: z.string().optional(),
  verificationFingerprint: z.string().optional(),
  sourceConnection: MysqlConnectionSchema.optional(),
  targetConnection: PostgresConnectionSchema.optional(),
});

function resolveRuntimeConnections(project, overrides = {}) {
  return {
    sourceConnection: overrides.sourceConnection || project.runtimeSourceConnection || project.sourceConnection,
    targetConnection: overrides.targetConnection || project.runtimeTargetConnection || project.targetConnection,
  };
}

function ensureMysqlPassword(connection, res) {
  if (String(connection.password || '').length > 0) return true;
  res.status(400).json({ ok: false, error: 'Source MySQL password is required' });
  return false;
}

function ensurePostgresPassword(connection, res) {
  if (String(connection.connectionString || '').trim()) return true;
  if (String(connection.pooler?.password || '').length > 0) return true;
  res.status(400).json({ ok: false, error: 'Target PostgreSQL password or connection string is required' });
  return false;
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
      const sourceCatalog = await introspectMysqlSchema(payload.sourceConnection, { schema: payload.sourceSchema, includeViews: payload.includeViews });
      const targetCatalog = await introspectPostgresSchema(payload.targetConnection, { schema: payload.targetSchema, includeViews: payload.includeViews });
      const suggestions = buildAutoMapping({ sourceCatalog, targetCatalog });
      const project = await persistence.saveProject({
        id: makeId('project'),
        name: payload.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceConnection: { ...payload.sourceConnection, password: undefined, ref: payload.sourceConnection.ref || summarizeConnectionRefs({ sourceConnection: payload.sourceConnection }).source || payload.sourceConnection.database },
        targetConnection: { ...payload.targetConnection, connectionString: payload.targetConnection.connectionString ? '[provided]' : '', pooler: payload.targetConnection.pooler ? { ...payload.targetConnection.pooler, password: undefined } : undefined, ref: payload.targetConnection.ref || summarizeConnectionRefs({ targetConnection: payload.targetConnection }).target || payload.targetConnection.pooler?.database || 'target' },
        sourceSchema: payload.sourceSchema,
        targetSchema: payload.targetSchema,
        includeViews: payload.includeViews,
        sourceFingerprint: fingerprint(sourceCatalog),
        targetFingerprint: fingerprint(targetCatalog),
        sourceCatalog,
        targetCatalog,
        tableMappings: suggestions.tableMappings,
        autoMappingSummary: suggestions.summary,
        versions: [{ createdAt: new Date().toISOString(), tableMappings: suggestions.tableMappings }],
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

  router.post('/projects/:id/auto-map', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const suggestions = buildAutoMapping({ sourceCatalog: project.sourceCatalog, targetCatalog: project.targetCatalog });
    const next = { ...project, tableMappings: suggestions.tableMappings, autoMappingSummary: suggestions.summary, updatedAt: new Date().toISOString() };
    await persistence.saveProject(next);
    res.json({ ok: true, project: next, suggestions });
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
      });
      const pendingSchemaActions = schemaPlan.tables.filter((table) => ['create_table', 'alter_table_add_columns'].includes(table.action));
      const blockingSchemaIssues = schemaPlan.tables.filter((table) => ['missing_target_table', 'target_name_conflict', 'manual_fix_required'].includes(table.action) || (table.issues || []).length > 0);
      const tableReadiness = report.tables.map((table) => ({
        sourceTable: table.sourceTable,
        targetTable: table.targetTable,
        readiness: table.readiness,
        completeness: table.completeness,
        schemaAction: table.schemaAction,
        blockerCount: table.blockers.length,
        warningCount: table.warnings.length,
      }));
      const executionPlan = executionEngine.buildExecutionPlan(project, { mode: 'all', selectedTables: [] });
      const readyToLoad = report.summary.blockerCount === 0 && pendingSchemaActions.length === 0 && blockingSchemaIssues.length === 0;
      const verificationFingerprint = fingerprint({ report, schemaPlan, updatedAt: project.updatedAt });
      res.json({ ok: true, verification: { report, schemaPlan, tableReadiness, pendingSchemaActions, blockingSchemaIssues, executionPlan, readyToLoad, verificationFingerprint } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  });

  router.get('/runs/:id/cutover-readiness', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });

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
    const runtime = resolveRuntimeConnections(project || {}, {});
    const runReport = await validateRunReport({
      run,
      persistence,
      project,
      countSourceRows: project ? async (tableName) => countMysqlRows(runtime.sourceConnection || project.sourceConnection, project.sourceSchema, tableName) : undefined,
      countTargetRows: project ? async (tableName) => countPostgresRows(runtime.targetConnection || project.targetConnection, project.targetSchema, tableName) : undefined,
    });
    const cutover = buildCutoverReadinessReport({ verification, runReport, project });
    res.json({ ok: true, cutover });
  });

  router.post('/projects/:id/dry-run', async (req, res) => {
    const project = await persistence.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    try {
      const runtime = resolveRuntimeConnections(project, { sourceConnection: req.body?.sourceConnection, targetConnection: req.body?.targetConnection });
      if (!ensureMysqlPassword(runtime.sourceConnection, res)) return;
      const preview = await buildDryRunPreview({
        project,
        sampleSourceRows: async (tableName, limit) => sampleMysqlTableRows(runtime.sourceConnection, project.sourceSchema, tableName, limit || 5),
      });
      await persistence.saveReport({ id: makeId('dryrun'), projectId: project.id, type: 'dry-run', createdAt: new Date().toISOString(), report: preview });
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

    if (parsed.data.cutoverMode === 'guarded') {
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
      });
      const currentVerificationFingerprint = fingerprint({ report, schemaPlan, updatedAt: project.updatedAt });
      if (!parsed.data.verificationFingerprint || parsed.data.verificationFingerprint !== currentVerificationFingerprint) {
        return res.status(409).json({ ok: false, error: 'Verification is stale. Re-run verification before guarded execution.' });
      }
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
        cutoverMode: parsed.data.cutoverMode,
        watermarkColumn: parsed.data.watermarkColumn || null,
        consistentRead: runtime.sourceConnection?.consistentRead || { enabled: false },
        consistencyMode: runtime.sourceConnection?.consistentRead?.enabled ? 'table-snapshot' : 'best-effort',
        verificationFingerprint: parsed.data.verificationFingerprint || null,
      },
    };
    await persistence.saveRun(runRecord);
    res.json({ ok: true, runId });

    setImmediate(async () => {
      try {
        publishRunEvent(runId, 'status', { status: 'running' });
        await executionEngine.executeRun({
          runId,
          project: { ...project, runtimeSourceConnection: runtime.sourceConnection, runtimeTargetConnection: runtime.targetConnection },
          options: parsed.data,
          publish(event, data) {
            publishRunEvent(runId, event, data);
          },
        });
        const finished = await persistence.getRun(runId);
        publishRunEvent(runId, 'status', { status: finished?.status || 'done' });
      } catch (error) {
        await persistence.saveRun({ ...(await persistence.getRun(runId)), status: 'error', error: error.message || String(error), updatedAt: new Date().toISOString() });
        publishRunEvent(runId, 'log', { level: 'error', message: error.message || String(error) });
        publishRunEvent(runId, 'status', { status: 'error' });
      }
    });
  });

  router.post('/runs/:id/resume', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    res.json({ ok: true, runId: run.id, status: 'resume-scheduled' });
    setImmediate(async () => {
      await executionEngine.resumeRun({ runId: run.id, project, publish(event, data) { publishRunEvent(run.id, event, data); } });
    });
  });

  router.post('/runs/:id/rerun-failed', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const failedTables = (run.tableStatuses || []).filter((table) => table.status === 'error').map((table) => table.tableName);
    const project = await persistence.getProject(run.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    const rerunId = makeId('run');
    await persistence.saveRun({
      id: rerunId,
      projectId: project.id,
      mode: 'selected',
      selectedTables: failedTables,
      dryRun: false,
      errorPolicy: run.errorPolicy || 'fail-fast',
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      counters: {},
      tableStatuses: [],
      rerunOf: run.id,
      executionProfile: {
        ...(run.executionProfile || {}),
        consistencyMode: run.executionProfile?.consistencyMode || 'best-effort',
      },
    });
    res.json({ ok: true, runId: rerunId, selectedTables: failedTables });
    setImmediate(async () => {
      await executionEngine.executeRun({
        runId: rerunId,
        project,
        options: { mode: 'selected', selectedTables: failedTables, dryRun: false, errorPolicy: run.errorPolicy || 'fail-fast' },
        publish(event, data) {
          publishRunEvent(rerunId, event, data);
        },
      });
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

  router.get('/runs/:id/report', async (req, res) => {
    const run = await persistence.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const project = await persistence.getProject(run.projectId);
    const runtime = resolveRuntimeConnections(project || {}, {});
    const report = await validateRunReport({
      run,
      persistence,
      project,
      countSourceRows: project ? async (tableName) => countMysqlRows(runtime.sourceConnection || project.sourceConnection, project.sourceSchema, tableName) : undefined,
      countTargetRows: project ? async (tableName) => countPostgresRows(runtime.targetConnection || project.targetConnection, project.targetSchema, tableName) : undefined,
    });
    res.json({ ok: true, report });
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
    const runtime = resolveRuntimeConnections(project, { targetConnection: req.body?.targetConnection });
    if (!ensurePostgresPassword(runtime.targetConnection, res)) return;
    const corrections = Array.isArray(req.body?.corrections) ? req.body.corrections : [];
    const replay = await replayCorrectedRows({
      persistence,
      runId: run.id,
      project,
      targetConnection: runtime.targetConnection,
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
    payload.importedAt = new Date().toISOString();
    payload.updatedAt = new Date().toISOString();
    const project = await persistence.saveProject(payload);
    res.json({ ok: true, project });
  });

  app.use(basePath, router);
  return { router };
}

module.exports = { registerMysqlPgMigrateRoutes };