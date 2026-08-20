const { requireToolDep } = require('../requireToolDep');
const { CHAT_MODELS, DEFAULT_SETTINGS, mergeSettings, stripSecrets, configured } = require('./config');
const { GptStore } = require('./store');
const { CorpusReader } = require('./corpus');
const { ResearchEngine } = require('./research');
const setup = require('./setup');
const ollama = require('./ollama');

const express = requireToolDep('express');
const SETUP_MODELS = ['embeddinggemma', ...CHAT_MODELS];

function envSettings() {
  return mergeSettings({
    chatModel: process.env.GPT_CHAT_MODEL || '',
    embeddingModel: process.env.GPT_EMBEDDING_MODEL || 'embeddinggemma',
    ollamaBaseUrl: process.env.GPT_OLLAMA_URL || 'http://127.0.0.1:11434',
    indexConnection: process.env.GPT_INDEX_URL ? { connectionString: process.env.GPT_INDEX_URL } : undefined,
    chatConnection: process.env.GPT_CHAT_DATABASE_URL ? { connectionString: process.env.GPT_CHAT_DATABASE_URL } : undefined,
  }, DEFAULT_SETTINGS);
}

function safeError(error) {
  return String(error?.message || error || 'Unexpected error')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/giu, '$1***$3')
    .replace(/(https?:\/\/[^?\s"']+)\?[^\s"']+/giu, '$1?[signed download URL removed]')
    .slice(0, 4000);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerGptRoutes(app, { basePath = '/api/tools/gpt', deps = {} } = {}) {
  const router = express.Router();
  const store = deps.store || new GptStore();
  const corpus = deps.corpus || new CorpusReader();
  const research = deps.research || new ResearchEngine({
    corpus,
    onCheckpoint: (turnId, fields) => store.updateTurn(turnId, fields),
  });
  const setupManager = deps.setupManager || setup;
  const ollamaClient = deps.ollamaClient || ollama;
  let settings = mergeSettings(deps.settings || envSettings());
  let settingsHydrated = false;
  let settingsHydration = null;
  const activeTurns = new Map();
  const activeModelPulls = new Set();

  async function hydrateSettings() {
    if (settingsHydrated || typeof store.loadSettings !== 'function') return;
    if (!settingsHydration) settingsHydration = (async () => {
      try {
        await store.initialize(settings.chatConnection);
        const persisted = await store.loadSettings();
        if (persisted) {
          settings = mergeSettings(persisted, settings);
          await store.persistSettings(stripSecrets(settings));
        }
        settingsHydrated = true;
      } catch {
        // Setup remains available when the conversation database is not ready yet.
      } finally { settingsHydration = null; }
    })();
    await settingsHydration;
  }

  router.use((req, res, next) => {
    const address = String(req.socket?.remoteAddress || '').toLocaleLowerCase();
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
      return res.status(403).json({ ok: false, error: 'GPT is available only from this computer.' });
    }
    return next();
  });
  router.use(express.json({ limit: '2mb' }));

  router.get('/setup/status', asyncRoute(async (req, res) => {
    let models = [];
    let ollamaError = null;
    const ollamaBaseUrl = String(req.query.ollamaBaseUrl || settings.ollamaBaseUrl);
    try { models = await ollamaClient.listModels({ baseUrl: ollamaBaseUrl }); }
    catch (error) { ollamaError = safeError(error); }
    const installed = new Set(models.flatMap((model) => [model.name, model.model]).filter(Boolean).map((name) => String(name).toLocaleLowerCase()));
    res.json({
      ok: true,
      database: setupManager.statusDefaults(settings.indexConnection.database),
      ollama: {
        available: !ollamaError,
        error: ollamaError,
        baseUrl: ollamaBaseUrl,
        models: SETUP_MODELS.map((model) => ({
          model,
          installed: installed.has(model.toLocaleLowerCase()) || installed.has(`${model.toLocaleLowerCase()}:latest`),
        })),
      },
    });
  }));

  router.post('/setup/database', asyncRoute(async (req, res) => {
    const result = await setupManager.provisionDatabases({
      adminConnection: req.body?.adminConnection || {},
      indexDatabase: req.body?.indexDatabase || settings.indexConnection.database,
      indexRolePassword: String(req.body?.indexRolePassword || ''),
      chatRolePassword: String(req.body?.chatRolePassword || ''),
    });
    res.status(201).json({ ok: true, result });
  }));

  router.post('/setup/models/pull', (req, res, next) => {
    Promise.resolve().then(async () => {
      const model = String(req.body?.model || '').trim();
      if (!SETUP_MODELS.includes(model)) return res.status(400).json({ ok: false, error: 'Only the GPT setup models can be installed here.' });
      if (activeModelPulls.has(model)) return res.status(409).json({ ok: false, error: `${model} is already being installed.` });
      activeModelPulls.add(model);
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      res.once('close', () => { if (!res.writableEnded) abort(); });
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      const emit = (type, payload = {}) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify({ type, model, ...payload })}\n`);
      };
      emit('status', { message: `Preparing ${model}` });
      try {
        const result = await ollamaClient.pullModel({
          baseUrl: req.body?.ollamaBaseUrl || settings.ollamaBaseUrl,
          model,
          signal: controller.signal,
          onProgress: (progress) => {
            const completed = Number(progress.completed) || 0;
            const total = Number(progress.total) || 0;
            emit('progress', { message: progress.status || 'Downloading', completed, total, percent: total ? Math.round((completed / total) * 100) : null });
          },
        });
        emit('done', { message: `${model} is installed`, result });
      } catch (error) {
        emit('error', {
          error: controller.signal.aborted
            ? 'Model installation cancelled'
            : safeError(ollama.explainPullError(error)),
        });
      } finally {
        activeModelPulls.delete(model);
        if (!res.writableEnded && !res.destroyed) res.end();
      }
      return undefined;
    }).catch(next);
  });

  async function initializeRuntime(nextSettings) {
    if (!configured(nextSettings)) return { configured: false };
    const [chatDatabase, corpusStatus] = await Promise.all([
      store.initialize(nextSettings.chatConnection),
      corpus.inspect(nextSettings.indexConnection),
    ]);
    await store.persistSettings(stripSecrets(nextSettings));
    return { configured: true, chatDatabase, corpus: corpusStatus };
  }

  router.get('/settings', asyncRoute(async (_req, res) => {
    await hydrateSettings();
    res.json({ ok: true, settings: stripSecrets(settings), configured: configured(settings), chatModels: CHAT_MODELS });
  }));

  router.put('/settings', asyncRoute(async (req, res) => {
    await hydrateSettings();
    if (req.body?.chatModel && !CHAT_MODELS.includes(req.body.chatModel)) return res.status(400).json({ ok: false, error: 'Unsupported Qwen model tag' });
    const previousModel = settings.chatModel;
    const next = mergeSettings(req.body || {}, settings);
    const readiness = await initializeRuntime(next);
    settings = next;
    if (previousModel && previousModel !== next.chatModel) {
      await ollama.unload({ baseUrl: next.ollamaBaseUrl, model: previousModel }).catch(() => undefined);
    }
    return res.json({ ok: true, settings: stripSecrets(settings), readiness });
  }));

  router.get('/health', asyncRoute(async (_req, res) => {
    await hydrateSettings();
    const response = { ok: true, tool: 'gpt', configured: configured(settings), ready: false, checks: {}, chatModels: CHAT_MODELS };
    if (!response.configured) return res.json(response);
    const checks = await Promise.allSettled([
      store.initialize(settings.chatConnection),
      corpus.inspect(settings.indexConnection),
      ollama.runtimeHealth({ baseUrl: settings.ollamaBaseUrl, chatModel: settings.chatModel, embeddingModel: settings.embeddingModel }),
      store.listBenchmarks(),
    ]);
    const names = ['chatDatabase', 'corpus', 'ollama', 'benchmarks'];
    checks.forEach((result, index) => {
      response.checks[names[index]] = result.status === 'fulfilled'
        ? { status: 'ready', details: result.value }
        : { status: 'error', error: safeError(result.reason) };
    });
    response.ready = checks.slice(0, 3).every((result) => result.status === 'fulfilled') &&
      Boolean(response.checks.ollama?.details?.chatModel?.installed && response.checks.ollama?.details?.embeddingModel?.installed);
    return res.json(response);
  }));

  async function requireReady(_req, res, next) {
    await hydrateSettings();
    if (!configured(settings)) return res.status(409).json({ ok: false, error: 'Complete GPT Setup and select a Qwen model first.' });
    return next();
  }

  router.get('/conversations', requireReady, asyncRoute(async (_req, res) => {
    await store.initialize(settings.chatConnection);
    res.json({ ok: true, conversations: await store.listConversations() });
  }));
  router.post('/conversations', requireReady, asyncRoute(async (req, res) => {
    await store.initialize(settings.chatConnection);
    res.status(201).json({ ok: true, conversation: await store.createConversation(req.body?.title) });
  }));
  router.patch('/conversations/:id', requireReady, asyncRoute(async (req, res) => {
    res.json({ ok: true, conversation: await store.renameConversation(req.params.id, req.body?.title) });
  }));
  router.delete('/conversations/:id', requireReady, asyncRoute(async (req, res) => {
    res.json({ ok: true, deleted: await store.deleteConversation(req.params.id) });
  }));
  router.get('/conversations/:id/messages', requireReady, asyncRoute(async (req, res) => {
    res.json({ ok: true, conversation: await store.getConversation(req.params.id) });
  }));

  async function streamTurn(req, res, { conversationId, question }) {
    const content = String(question || '').trim();
    if (!content || content.length > 12000) return res.status(400).json({ ok: false, error: 'Message must contain between 1 and 12,000 characters.' });
    await store.initialize(settings.chatConnection);
    await corpus.configure(settings.indexConnection);
    const context = await store.recentContext(conversationId);
    const { turnId } = await store.beginTurn(conversationId, content);
    const controller = new AbortController();
    activeTurns.set(turnId, controller);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const emit = (type, payload = {}) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify({ type, turnId, ...payload })}\n`);
    };
    const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    emit('status', { stage: 'queued', message: 'Starting local research' });
    try {
      const result = await research.run({ turnId, question: content, context, settings, signal: controller.signal, emit });
      const completed = await store.completeTurn({
        turnId, conversationId, answer: result.answer, memory: result.memory, modelTag: settings.chatModel,
        evidence: result.sources || [], stats: result.stats,
      });
      emit('answer', { message: { id: completed.assistantMessageId, role: 'assistant', content: result.answer, turnId,
        sources: result.sources || [], researchDetails: result.stats || {} } });
      emit('sources', { sources: result.sources || [] });
      emit('done', { stats: result.stats, objective: result.objective, probes: result.probes || [] });
    } catch (error) {
      const cancelled = error?.name === 'AbortError' || controller.signal.aborted;
      await store.failTurn(turnId, cancelled ? 'cancelled' : 'failed', safeError(error)).catch(() => undefined);
      emit('error', { error: cancelled ? 'Research cancelled' : safeError(error), cancelled });
    } finally {
      activeTurns.delete(turnId);
      if (settings.unloadAfterTurn && activeTurns.size === 0 && typeof ollamaClient.unload === 'function') {
        await ollamaClient.unload({ baseUrl: settings.ollamaBaseUrl, model: settings.chatModel }).catch(() => undefined);
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  router.post('/conversations/:id/messages', requireReady, (req, res, next) => {
    streamTurn(req, res, { conversationId: req.params.id, question: req.body?.content }).catch(next);
  });

  router.post('/turns/:id/cancel', requireReady, asyncRoute(async (req, res) => {
    const controller = activeTurns.get(req.params.id);
    if (!controller) return res.status(404).json({ ok: false, error: 'Active turn not found' });
    controller.abort();
    return res.json({ ok: true, cancelled: req.params.id });
  }));

  router.post('/turns/:id/regenerate', requireReady, (req, res, next) => {
    Promise.resolve().then(async () => {
      const conversationId = await store.turnConversation(req.params.id);
      const question = await store.latestUserQuestion(conversationId);
      return streamTurn(req, res, { conversationId, question });
    }).catch(next);
  });

  router.get('/sources/:sourceId', requireReady, asyncRoute(async (req, res) => {
    await corpus.configure(settings.indexConnection);
    const passageIndex = req.query.passageIndex == null ? null : Number(req.query.passageIndex);
    res.json({ ok: true, source: await corpus.getSource(req.params.sourceId, passageIndex) });
  }));

  router.get('/benchmarks', requireReady, asyncRoute(async (_req, res) => {
    res.json({ ok: true, benchmarks: await store.listBenchmarks() });
  }));
  router.post('/benchmarks', requireReady, asyncRoute(async (req, res) => {
    if (!CHAT_MODELS.includes(req.body?.modelTag)) return res.status(400).json({ ok: false, error: 'Unsupported benchmark model tag' });
    res.status(201).json({ ok: true, benchmark: await store.saveBenchmark(req.body) });
  }));

  router.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: safeError(error) });
  });
  app.use(basePath, router);
  return { store, corpus, research, getSettings: () => settings, activeTurns };
}

module.exports = { registerGptRoutes, safeError, envSettings };
