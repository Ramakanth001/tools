const { requireToolDep } = require('../requireToolDep');
const database = require('./database');
const ollama = require('./ollama');
const { createSyncManager, sanitizeError } = require('./syncManager');
const {
  createDeepSummaryManager,
  DEFAULT_DEEP_PARALLEL_REQUESTS,
  MAX_DEEP_PARALLEL_REQUESTS,
  DEFAULT_DEEP_RECORDS,
  MAX_DEEP_RECORDS,
  DEFAULT_DEEP_REQUEST_TIMEOUT_MS,
  MAX_DEEP_REQUEST_TIMEOUT_MS,
} = require('./deepSummaryManager');
const { reconstructDocument, mapDocumentHighlights } = require('./documentService');
const {
  buildLexicalQuery,
  buildQueryEmbeddingText,
  buildSearchResponse,
  embeddingFormatForModel,
  orderMatches,
  rerankPassageMatches,
  rerankTextMatches,
  NO_MATCH_MESSAGE,
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
const SEARCH_THRESHOLD = 0.08;

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

const SummaryModelSchema = z.object({
  summaryModel: z.string().trim().min(1).default('gemma3:4b'),
  hardwarePreference: z.enum(['auto', 'gpu', 'cpu']).default('auto'),
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
  if (Number(status.recordCount) > 0 && Number(status.passageCount) === 0) {
    rebuildReasons.push('the answer-passage index is empty');
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
  const deepSummaryManager = deps.deepSummaryManager || createDeepSummaryManager({
    validateEvidence: embedding.validateEvidenceBatch,
    extractClaims: embedding.extractGroundedClaims,
    consolidateClaims: embedding.consolidateGroundedClaims,
    synthesize: embedding.synthesizeDeepAnswer,
    inspectHardware: embedding.getOllamaHardware,
  });
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', (_req, res) => res.json({ ok: true, tool: 'semantic-qa' }));

  router.post('/diagnostics', async (req, res) => {
    const ollamaInput = OllamaSchema.safeParse(req.body || {});
    const summaryInput = SummaryModelSchema.safeParse(req.body || {});
    const sourceInput = ConnectionSchema.safeParse(req.body?.sourceConnection || {});
    const indexInput = ConnectionSchema.safeParse(req.body?.indexConnection || {});
    const [ollamaCheck, summaryCheck, sourceCheck, indexCheck] = await Promise.all([
      ollamaInput.success
        ? diagnosticCheck(() => embedding.testOllama({ baseUrl: ollamaInput.data.ollamaBaseUrl, model: ollamaInput.data.model }))
        : Promise.resolve({ status: 'not_configured', error: 'Ollama URL and model are required.' }),
      ollamaInput.success && summaryInput.success && typeof embedding.testChatModel === 'function'
        ? diagnosticCheck(() => embedding.testChatModel({
          baseUrl: ollamaInput.data.ollamaBaseUrl,
          model: summaryInput.data.summaryModel,
          hardwarePreference: summaryInput.data.hardwarePreference,
        }))
        : Promise.resolve({ status: 'not_configured', error: 'A local summary model is required for synthesized answers.' }),
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
        summaryModel: summaryCheck,
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

  router.post('/ollama/hardware', async (req, res) => {
    const data = parseOrReply(z.object({
      ollamaBaseUrl: z.string().url().default('http://127.0.0.1:11434'),
      model: z.string().trim().min(1).default('gemma3:4b'),
    }), req.body, res);
    if (!data) return;
    if (typeof embedding.getOllamaHardware !== 'function') return res.status(501).json({ ok: false, error: 'Ollama hardware detection is unavailable' });
    try {
      res.json({ ok: true, hardware: await embedding.getOllamaHardware({ baseUrl: data.ollamaBaseUrl, model: data.model }) });
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

  router.post('/documents/list', async (req, res) => {
    const data = parseOrReply(z.object({
      indexConnection: ConnectionSchema,
      query: z.string().max(500).optional().default(''),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(100).default(50),
    }), req.body, res);
    if (!data) return;
    try { res.json({ ok: true, ...await db.listDocuments(data.indexConnection, data) }); }
    catch (error) { routeError(res, error); }
  });

  router.post('/documents/get', async (req, res) => {
    const data = parseOrReply(z.object({
      indexConnection: ConnectionSchema,
      reference: z.string().trim().min(1).max(500),
      highlights: z.array(z.object({
        sourceId: z.string().trim().min(1).max(500),
        start: z.coerce.number().int().min(0),
        end: z.coerce.number().int().positive(),
        label: z.string().max(200).optional(),
        evidenceNumber: z.coerce.number().int().positive().optional(),
      })).max(100).optional().default([]),
    }), req.body, res);
    if (!data) return;
    try {
      const records = await db.getDocumentRecords(data.indexConnection, data.reference);
      if (!records.length) return res.status(404).json({ ok: false, error: 'Source document not found' });
      const document = reconstructDocument(records);
      res.json({ ok: true, document: { ...document, highlights: mapDocumentHighlights(document, data.highlights) } });
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

  router.get('/deep-summary/:jobId', (req, res) => {
    const job = deepSummaryManager.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Deep summary job not found' });
    res.json({ ok: true, job });
  });

  router.post('/deep-summary/:jobId/cancel', (req, res) => {
    const job = deepSummaryManager.cancel(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Deep summary job not found' });
    res.json({ ok: true, job });
  });

  router.get('/deep-summary/:jobId/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    if (!deepSummaryManager.subscribe(req.params.jobId, res)) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Deep summary job not found' })}\n\n`);
      return res.end();
    }
    req.on('close', () => deepSummaryManager.unsubscribe(req.params.jobId, res));
  });

  router.post('/search', async (req, res) => {
    const schema = z.object({
      indexConnection: ConnectionSchema,
      ollamaBaseUrl: z.string().url().default('http://127.0.0.1:11434'),
      question: z.string().trim().min(1).max(20000),
      searchMode: z.enum(['semantic', 'search']).default('semantic'),
      topK: z.coerce.number().int().min(1).max(20).default(5),
      threshold: z.coerce.number().min(-1).max(1).default(0.60),
      summary: z.object({
        enabled: z.boolean().default(false),
        mode: z.enum(['off', 'standard', 'deep']).optional(),
        model: z.string().trim().min(1).default('gemma3:4b'),
        maxRecords: z.coerce.number().int().min(1).max(MAX_RECORDS).default(DEFAULT_MAX_RECORDS),
        maxLines: z.coerce.number().int().min(1).max(MAX_LINES).default(DEFAULT_MAX_LINES),
        deepMaxRecords: z.coerce.number().int().min(1).max(MAX_DEEP_RECORDS).default(DEFAULT_DEEP_RECORDS),
        parallelRequests: z.coerce.number().int().min(1).max(MAX_DEEP_PARALLEL_REQUESTS).default(DEFAULT_DEEP_PARALLEL_REQUESTS),
        requestTimeoutMs: z.coerce.number().int().min(60000).max(MAX_DEEP_REQUEST_TIMEOUT_MS).default(DEFAULT_DEEP_REQUEST_TIMEOUT_MS),
        hardwarePreference: z.enum(['auto', 'gpu', 'cpu']).default('auto'),
      }).optional().default({
        enabled: false,
        mode: 'off',
        model: 'gemma3:4b',
        maxRecords: DEFAULT_MAX_RECORDS,
        maxLines: DEFAULT_MAX_LINES,
        deepMaxRecords: DEFAULT_DEEP_RECORDS,
        parallelRequests: DEFAULT_DEEP_PARALLEL_REQUESTS,
        requestTimeoutMs: DEFAULT_DEEP_REQUEST_TIMEOUT_MS,
        hardwarePreference: 'auto',
      }),
    });
    const data = parseOrReply(schema, req.body, res);
    if (!data) return;
    try {
      const summaryMode = data.summary.mode || (data.summary.enabled ? 'standard' : 'off');
      const status = await db.getIndexStatus(data.indexConnection);
      if (!status.initialized || !status.corpus || !status.recordCount) {
        const effectiveThreshold = data.searchMode === 'semantic' ? data.threshold : SEARCH_THRESHOLD;
        const deepSummaryJob = summaryMode === 'deep' ? deepSummaryManager.start({
          question: data.question,
          searchMode: data.searchMode,
          threshold: effectiveThreshold,
          matches: [],
          retrievalCoverage: { exhaustive: true, scannedPassages: 0 },
          baseUrl: data.ollamaBaseUrl,
          model: data.summary.model,
          parallelRequests: data.summary.parallelRequests,
          requestTimeoutMs: data.summary.requestTimeoutMs,
          hardwarePreference: data.summary.hardwarePreference,
        }) : null;
        return res.json({
          ok: true,
          searchMode: data.searchMode,
          effectiveThreshold,
          ...buildSearchResponse([], effectiveThreshold),
          ...(summaryMode === 'standard' ? {
            relevantMatches: [],
            summary: {
              status: 'not_available',
              mode: SUMMARY_MODE,
              reason: 'no_relevant_records',
              evidence: [],
            },
          } : {}),
          ...(deepSummaryJob ? { deepSummaryJob } : {}),
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
      const needsSemanticVector = data.searchMode === 'semantic';
      if (needsSemanticVector && status.corpus.embeddingModelDigest && typeof embedding.getModelIdentity === 'function') {
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
      let vectors = null;
      if (needsSemanticVector) {
        vectors = await embedding.embedTexts({
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
      }
      const rankedRecordLimit = summaryMode === 'deep'
        ? Math.max(data.topK, data.summary.deepMaxRecords)
        : summaryMode === 'standard'
          ? Math.max(data.topK, data.summary.maxRecords * 4)
        : data.topK;
      const candidateLimit = Math.max(60, rankedRecordLimit * 12);
      const exhaustiveSemanticSearch = needsSemanticVector && typeof db.searchAllPassageIndex === 'function';
      const result = exhaustiveSemanticSearch
        ? await db.searchAllPassageIndex(
          data.indexConnection,
          vectors[0],
          buildLexicalQuery(data.question),
          Math.max(0.25, data.threshold - 0.18),
        )
        : needsSemanticVector
          ? await db.searchPassageIndex(data.indexConnection, vectors[0], buildLexicalQuery(data.question), candidateLimit)
        : await db.searchTextIndex(data.indexConnection, data.question, rankedRecordLimit);
      const rerankLimit = result.exhaustive ? Math.max(1, result.rows.length) : rankedRecordLimit;
      const rankedMatches = orderMatches(
        needsSemanticVector
          ? rerankPassageMatches(result.rows, data.question, rerankLimit)
          : rerankTextMatches(result.rows, rankedRecordLimit),
        data.question,
      );
      const visibleMatches = rankedMatches
        .slice(0, data.topK)
        .map(({ rankingSignals: _rankingSignals, ...match }) => match);
      const effectiveThreshold = needsSemanticVector ? data.threshold : SEARCH_THRESHOLD;
      const response = buildSearchResponse(visibleMatches, effectiveThreshold, data.question);
      let summaryResult = {};
      if (summaryMode === 'standard') {
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
              question: data.question,
              matches: rankedMatches,
              threshold: effectiveThreshold,
              maxRecords: data.summary.maxRecords,
              maxLines: data.summary.maxLines,
              baseUrl: data.ollamaBaseUrl,
              model: data.summary.model,
              hardwarePreference: data.summary.hardwarePreference,
              generateAnswer: embedding.generateGroundedAnswer,
            });
          } catch (summaryError) {
            summaryResult = {
              relevantMatches: filterRelevantMatches(rankedMatches, effectiveThreshold, {
                maxRecords: data.summary.maxRecords,
              })
                .map(({ answer: _answer, metadata: _metadata, rankingSignals: _rankingSignals, lexicalScore: _lexicalScore, ...match }) => match),
              summary: {
                status: 'unavailable',
                mode: SUMMARY_MODE,
                reason: 'summary_generation_failed',
                error: sanitizeError(summaryError),
                evidence: [],
              },
            };
          }
        }
      }
      if (summaryResult.summary?.reason === 'no_answerable_evidence') {
        response.strongMatch = false;
        response.message = NO_MATCH_MESSAGE;
        delete response.acceptedMatch;
      }
      let deepSummaryJob;
      if (summaryMode === 'deep') {
        deepSummaryJob = deepSummaryManager.start({
          question: data.question,
          searchMode: data.searchMode,
          threshold: effectiveThreshold,
          matches: rankedMatches,
          retrievalCoverage: {
            exhaustive: Boolean(result.exhaustive),
            scannedPassages: Number(result.scannedPassages) || 0,
          },
          baseUrl: data.ollamaBaseUrl,
          model: data.summary.model,
          parallelRequests: data.summary.parallelRequests,
          requestTimeoutMs: data.summary.requestTimeoutMs,
          hardwarePreference: data.summary.hardwarePreference,
        });
      }
      res.json({
        ok: true,
        searchMode: data.searchMode,
        effectiveThreshold,
        retrieval: data.searchMode === 'search' ? 'text-rrf' : (result.hybrid ? 'passage-hybrid' : 'passage-dense'),
        ...response,
        ...summaryResult,
        ...(deepSummaryJob ? { deepSummaryJob } : {}),
      });
    } catch (error) { routeError(res, error); }
  });

  app.use(basePath, router);
  return { router, syncManager, deepSummaryManager };
}

module.exports = {
  registerSemanticQaRoutes,
  ConnectionSchema,
  MappingSchema,
  OllamaSchema,
  SummaryModelSchema,
  indexCompatibility,
};
