const { requireToolDep } = require('../requireToolDep');
const database = require('./database');
const ollama = require('./ollama');
const { createSyncManager, sanitizeError } = require('./syncManager');
const {
  buildLexicalQuery,
  buildQueryEmbeddingText,
  buildSearchResponse,
  embeddingFormatForModel,
  orderMatches,
  rerankMatches,
  RETRIEVAL_SCHEMA_VERSION,
} = require('./core');
const {
  buildSemanticSummary,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_RECORDS,
  filterRelevantMatches,
  MAX_LINES,
  MAX_RECORDS,
  SUMMARY_MODE,
} = require('./semanticSummary');

const express = requireToolDep('express');
const { z } = requireToolDep('zod');

const ConnectionSchema = z.object({
  connectionString: z.string().optional().default(''),
  host: z.string().optional().default('127.0.0.1'),
  port: z.coerce.number().int().positive().max(65535).optional().default(5432),
  user: z.string().optional().default(''),
  password: z.string().optional().default(''),
  database: z.string().optional().default('postgres'),
  sslMode: z.enum(['disable', 'prefer', 'require', 'verify-full', 'no-verify']).optional().default('prefer'),
}).refine((value) => Boolean(value.connectionString.trim() || (value.host.trim() && value.user.trim() && value.database.trim())), {
  message: 'Provide a connection string or host, user, and database',
});

const MappingSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  idColumn: z.string().min(1),
  questionColumn: z.string().min(1),
  answerColumn: z.string().min(1),
  metadataColumns: z.array(z.string()).default([]),
  groupColumn: z.string().nullable().optional(),
  orderColumn: z.string().nullable().optional(),
});

const OllamaSchema = z.object({
  ollamaBaseUrl: z.string().url().default('http://127.0.0.1:11434'),
  model: z.string().trim().min(1).default('embeddinggemma'),
});

function parseOrReply(schema, body, res) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : 'request'}: ${issue.message}`)
      .join('; ');
    res.status(400).json({ ok: false, error, details: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

function routeError(res, error, status = 500) {
  const code = error?.code === 'SYNC_ACTIVE' ? 409 : status;
  return res.status(code).json({ ok: false, error: sanitizeError(error) });
}

async function diagnosticCheck(callback) {
  try {
    return { status: 'ready', details: await callback() };
  } catch (error) {
    return { status: 'error', error: sanitizeError(error) };
  }
}

function indexCompatibility(status) {
  const corpus = status?.corpus;
  if (!status?.initialized || !corpus) return { requiresRebuild: false, rebuildReasons: [] };
  const rebuildReasons = [];
  const expectedEmbeddingFormat = embeddingFormatForModel(corpus.embeddingModel);
  if (corpus.embeddingFormatVersion !== expectedEmbeddingFormat) {
    rebuildReasons.push(`embedding format ${corpus.embeddingFormatVersion || 'unknown'} is outdated (expected ${expectedEmbeddingFormat})`);
  }
  if (corpus.retrievalSchemaVersion !== RETRIEVAL_SCHEMA_VERSION) {
    rebuildReasons.push(`retrieval format ${corpus.retrievalSchemaVersion || 'unknown'} is outdated (expected ${RETRIEVAL_SCHEMA_VERSION})`);
  }
  if (!corpus.embeddingModelDigest) {
    rebuildReasons.push('the index does not record an immutable embedding-model digest');
  }
  return { requiresRebuild: rebuildReasons.length > 0, rebuildReasons };
}

function registerSemanticQaRoutes(app, { basePath = '/api/tools/semantic-qa', deps = {} } = {}) {
  const db = deps.database || database;
  const embedding = deps.ollama || ollama;
  const syncManager = deps.syncManager || createSyncManager({ db, embed: embedding.embedTexts, probe: embedding.testOllama });
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', (_req, res) => res.json({ ok: true, tool: 'semantic-qa' }));

  router.post('/diagnostics', async (req, res) => {
    const ollamaInput = OllamaSchema.safeParse(req.body || {});
    const sourceInput = ConnectionSchema.safeParse(req.body?.sourceConnection || {});
    const indexInput = ConnectionSchema.safeParse(req.body?.indexConnection || {});
    const [ollamaCheck, sourceCheck, indexCheck] = await Promise.all([
      ollamaInput.success
        ? diagnosticCheck(() => embedding.testOllama({ baseUrl: ollamaInput.data.ollamaBaseUrl, model: ollamaInput.data.model }))
        : Promise.resolve({ status: 'not_configured', error: 'Ollama URL and model are required.' }),
      sourceInput.success
        ? diagnosticCheck(() => db.testPostgresConnection(sourceInput.data))
        : Promise.resolve({ status: 'not_configured', error: 'Source PostgreSQL connection is not configured.' }),
      indexInput.success
        ? diagnosticCheck(() => db.testIndexConnection(indexInput.data))
        : Promise.resolve({ status: 'not_configured', error: 'Index PostgreSQL connection is not configured.' }),
    ]);
    res.json({
      ok: true,
      checks: {
        api: { status: 'ready', details: { tool: 'semantic-qa' } },
        ollama: ollamaCheck,
        sourceDatabase: sourceCheck,
        indexDatabase: indexCheck,
      },
    });
  });

  router.post('/source/test', async (req, res) => {
    const data = parseOrReply(z.object({ connection: ConnectionSchema }), req.body, res);
    if (!data) return;
    try {
      res.json({ ok: true, connection: await db.testPostgresConnection(data.connection) });
    } catch (error) { routeError(res, error); }
  });

  router.post('/source/catalog', async (req, res) => {
    const data = parseOrReply(z.object({ connection: ConnectionSchema }), req.body, res);
    if (!data) return;
    try {
      res.json({ ok: true, schemas: await db.discoverSourceCatalog(data.connection) });
    } catch (error) { routeError(res, error); }
  });

  router.post('/index/test', async (req, res) => {
    const data = parseOrReply(z.object({ connection: ConnectionSchema }), req.body, res);
    if (!data) return;
    try {
      res.json({ ok: true, connection: await db.testIndexConnection(data.connection) });
    } catch (error) { routeError(res, error); }
  });

  router.post('/ollama/test', async (req, res) => {
    const data = parseOrReply(OllamaSchema, req.body, res);
    if (!data) return;
    try {
      res.json(await embedding.testOllama({ baseUrl: data.ollamaBaseUrl, model: data.model }));
    } catch (error) { routeError(res, error); }
  });

  router.post('/index/initialize', async (req, res) => {
    const schema = z.object({ indexConnection: ConnectionSchema }).extend(OllamaSchema.shape);
    const data = parseOrReply(schema, req.body, res);
    if (!data) return;
    try {
      const model = await embedding.testOllama({ baseUrl: data.ollamaBaseUrl, model: data.model });
      const result = await db.initializeIndex(data.indexConnection, {
        model: data.model,
        modelDigest: model.digest,
        dimension: model.dimension,
        ollamaBaseUrl: data.ollamaBaseUrl,
      });
      res.json({ ok: true, model, ...result });
    } catch (error) { routeError(res, error); }
  });

  router.post('/index/status', async (req, res) => {
    const data = parseOrReply(z.object({ indexConnection: ConnectionSchema }), req.body, res);
    if (!data) return;
    try {
      const status = await db.getIndexStatus(data.indexConnection);
      res.json({ ok: true, ...status, ...indexCompatibility(status) });
    } catch (error) { routeError(res, error); }
  });

  router.post('/sync', async (req, res) => {
    const schema = z.object({
      sourceConnection: ConnectionSchema,
      indexConnection: ConnectionSchema,
      mapping: MappingSchema,
      mode: z.enum(['incremental', 'rebuild']).default('incremental'),
      fetchSize: z.coerce.number().int().min(25).max(1000).default(250),
      embeddingBatchSize: z.coerce.number().int().min(1).max(64).default(32),
    }).extend(OllamaSchema.shape);
    const data = parseOrReply(schema, req.body, res);
    if (!data) return;
    try {
      db.validateMapping(data.mapping);
      res.status(202).json({ ok: true, job: syncManager.start(data) });
    } catch (error) { routeError(res, error, 400); }
  });

  router.get('/sync/:jobId', (req, res) => {
    const job = syncManager.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Synchronization job not found' });
    res.json({ ok: true, job });
  });

  router.post('/sync/:jobId/cancel', (req, res) => {
    const job = syncManager.cancel(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Synchronization job not found' });
    res.json({ ok: true, job });
  });

  router.get('/sync/:jobId/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    if (!syncManager.subscribe(req.params.jobId, res)) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Synchronization job not found' })}\n\n`);
      return res.end();
    }
    req.on('close', () => syncManager.unsubscribe(req.params.jobId, res));
  });

  router.post('/search', async (req, res) => {
    const schema = z.object({
      indexConnection: ConnectionSchema,
      ollamaBaseUrl: z.string().url().default('http://127.0.0.1:11434'),
      question: z.string().trim().min(1).max(20000),
      topK: z.coerce.number().int().min(1).max(20).default(5),
      threshold: z.coerce.number().min(-1).max(1).default(0.60),
      summary: z.object({
        enabled: z.boolean().default(false),
        maxRecords: z.coerce.number().int().min(1).max(MAX_RECORDS).default(DEFAULT_MAX_RECORDS),
        maxLines: z.coerce.number().int().min(1).max(MAX_LINES).default(DEFAULT_MAX_LINES),
      }).optional().default({
        enabled: false,
        maxRecords: DEFAULT_MAX_RECORDS,
        maxLines: DEFAULT_MAX_LINES,
      }),
    });
    const data = parseOrReply(schema, req.body, res);
    if (!data) return;
    try {
      const status = await db.getIndexStatus(data.indexConnection);
      if (!status.initialized || !status.corpus || !status.recordCount) {
        return res.json({
          ok: true,
          ...buildSearchResponse([], data.threshold),
          ...(data.summary.enabled ? {
            relevantMatches: [],
            summary: {
              status: 'not_available',
              mode: SUMMARY_MODE,
              reason: 'no_relevant_records',
              evidence: [],
            },
          } : {}),
        });
      }
      const compatibility = indexCompatibility(status);
      if (compatibility.requiresRebuild) {
        return res.status(409).json({
          ok: false,
          error: `The search index is outdated; run a full rebuild. ${compatibility.rebuildReasons.join('; ')}.`,
          ...compatibility,
        });
      }
      if (status.corpus.embeddingModelDigest && typeof embedding.getModelIdentity === 'function') {
        const identity = await embedding.getModelIdentity({
          baseUrl: data.ollamaBaseUrl,
          model: status.corpus.embeddingModel,
        });
        if (identity.digest !== status.corpus.embeddingModelDigest) {
          return res.status(409).json({
            ok: false,
            requiresRebuild: true,
            error: 'The configured Ollama model no longer matches the model used to build this index; run a full rebuild.',
          });
        }
      }
      const vectors = await embedding.embedTexts({
        baseUrl: data.ollamaBaseUrl,
        model: status.corpus.embeddingModel,
        texts: [buildQueryEmbeddingText(data.question, {
          model: status.corpus.embeddingModel,
          formatVersion: status.corpus.embeddingFormatVersion,
        })],
      });
      if (vectors[0].length !== Number(status.corpus.embeddingDimension)) {
        return res.status(409).json({ ok: false, error: 'Embedding dimension changed; run a full rebuild.' });
      }
      const rankedRecordLimit = data.summary.enabled
        ? Math.max(data.topK, data.summary.maxRecords)
        : data.topK;
      const candidateLimit = Math.max(60, rankedRecordLimit * 12);
      const result = await db.searchIndex(
        data.indexConnection,
        vectors[0],
        buildLexicalQuery(data.question),
        candidateLimit,
      );
      const rankedMatches = orderMatches(rerankMatches(result.rows, data.question, rankedRecordLimit));
      const visibleMatches = rankedMatches
        .slice(0, data.topK)
        .map(({ rankingSignals: _rankingSignals, ...match }) => match);
      const response = buildSearchResponse(visibleMatches, data.threshold);
      let summaryResult = {};
      if (data.summary.enabled) {
        if (!response.strongMatch) {
          summaryResult = {
            relevantMatches: [],
            summary: {
              status: 'not_available',
              mode: SUMMARY_MODE,
              reason: 'no_relevant_records',
              evidence: [],
            },
          };
        } else {
          try {
            summaryResult = await buildSemanticSummary({
              queryVector: vectors[0],
              matches: rankedMatches,
              threshold: data.threshold,
              maxRecords: data.summary.maxRecords,
              maxLines: data.summary.maxLines,
              baseUrl: data.ollamaBaseUrl,
              model: status.corpus.embeddingModel,
              formatVersion: status.corpus.embeddingFormatVersion,
              embedTexts: embedding.embedTexts,
            });
          } catch (summaryError) {
            summaryResult = {
              relevantMatches: filterRelevantMatches(rankedMatches, data.threshold, {
                maxRecords: data.summary.maxRecords,
              })
                .map(({ answer: _answer, metadata: _metadata, rankingSignals: _rankingSignals, lexicalScore: _lexicalScore, ...match }) => match),
              summary: {
                status: 'unavailable',
                mode: SUMMARY_MODE,
                reason: 'summary_embedding_failed',
                error: sanitizeError(summaryError),
                evidence: [],
              },
            };
          }
        }
      }
      res.json({
        ok: true,
        retrieval: result.hybrid ? 'hybrid' : 'dense',
        ...response,
        ...summaryResult,
      });
    } catch (error) { routeError(res, error); }
  });

  app.use(basePath, router);
  return { router, syncManager };
}

module.exports = { registerSemanticQaRoutes, ConnectionSchema, MappingSchema, OllamaSchema, indexCompatibility };
