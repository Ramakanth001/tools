const crypto = require('node:crypto');
const database = require('./database');
const {
  buildPassageEmbeddingText,
  contentHash,
  embeddingFormatForModel,
  RETRIEVAL_SCHEMA_VERSION,
} = require('./core');
const { embedTexts, testOllama } = require('./ollama');
const { buildAnswerPassages, buildDiscoveryTexts, parseAnswerUnits } = require('./corpusStructure');
const { clearIdfCache } = require('./distanceSearch');

const MAX_SINGLE_PASSAGE_RETRIES = 2;

function connectionDatabase(connection = {}) {
  if (String(connection.database || '').trim()) return String(connection.database).trim();
  if (!connection.connectionString) return '';
  try {
    return decodeURIComponent(new URL(connection.connectionString).pathname.replace(/^\//u, ''));
  } catch {
    return '';
  }
}

function assertRoleAwareUniversalSource(config = {}) {
  const sourceDatabase = connectionDatabase(config.sourceConnection).toLowerCase();
  const schema = String(config.mapping?.schema || 'public').toLowerCase();
  const table = String(config.mapping?.table || '').toLowerCase();
  if (sourceDatabase === 'universal_qa_source' && schema === 'public' && table === 'qa_records') {
    const error = new Error('Role-aware v5 synchronization requires public.corpus_documents. The selected public.qa_records table contains legacy character chunks and is intentionally refused. Run the Universal MySQL import, then load the Universal corpus preset and select corpus_documents.');
    error.code = 'LEGACY_CHUNK_SOURCE';
    throw error;
  }
}

function isRetriableEmbeddingError(error) {
  return /timed out|temporar|fetch failed|socket|econnreset|econnrefused|enotfound|http 5\d\d/i
    .test(String(error?.message || error || ''));
}

function sanitizeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[redacted]@')
    .slice(0, 2000);
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    processed: job.processed,
    changed: job.changed,
    passages: job.passages,
    discoveryPassages: job.discoveryPassages,
    ambiguousDocuments: job.ambiguousDocuments,
    total: job.total,
    percent: job.total ? Math.round((job.processed / job.total) * 100) : 0,
    error: job.error,
    logs: [...job.logs],
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

function createSyncManager({ db = database, embed = embedTexts, probe = testOllama } = {}) {
  const jobs = new Map();

  function publish(job, event = 'status') {
    const payload = JSON.stringify(publicJob(job));
    for (const listener of [...job.listeners]) {
      try {
        listener.write(`event: ${event}\n`);
        listener.write(`data: ${payload}\n\n`);
      } catch {
        job.listeners.delete(listener);
      }
    }
  }

  function log(job, message) {
    job.logs.push(`[${new Date().toISOString()}] ${String(message)}`);
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
    publish(job, 'log');
  }

  function throwIfCancelled(job) {
    if (!job.cancelRequested) return;
    const error = new Error('Synchronization cancelled');
    error.code = 'SYNC_CANCELLED';
    throw error;
  }

  function placeholderRecordEmbedding(dimension) {
    const vector = Array.from({ length: Number(dimension) }, () => 0);
    vector[0] = 1;
    return vector;
  }

  function structuralRows(records, job) {
    const answerUnits = [];
    const passages = [];
    const discovery = [];
    const aliases = [];
    for (const record of records) {
      const questionContext = String(record.metadata?.question_context || record.metadata?.source_context || '').trim();
      const parsed = parseAnswerUnits({
        sourceId: record.sourceId,
        sourceType: record.metadata?.source_type || '',
        question: [record.question, questionContext].filter(Boolean).join('\n\n'),
        text: record.answer,
        language: record.metadata?.language || '',
        author: record.metadata?.author || '',
      });
      if (parsed.ambiguities.length) {
        job.ambiguousDocuments += 1;
        log(job, `Excluded ${record.sourceId} from citable evidence: ${parsed.ambiguities.map((item) => item.reason).join('; ')}`);
      }
      for (const unit of parsed.units) {
        if (record.answer.slice(unit.start, unit.end) !== unit.text) {
          throw new Error(`Answer-unit offsets do not reproduce source text for ${unit.answerUnitId}`);
        }
        answerUnits.push(unit);
      }
      const recordPassages = buildAnswerPassages(record.answer, parsed.units)
        .map((passage, passageIndex) => ({ ...passage, passageIndex }));
      for (const passage of recordPassages) {
        if (record.answer.slice(passage.start, passage.end) !== passage.text ||
            record.answer.slice(passage.citationStart, passage.citationEnd) !== passage.citationText) {
          throw new Error(`Passage offsets do not reproduce source text for ${record.sourceId}:${passage.passageIndex}`);
        }
      }
      passages.push(...recordPassages);
      discovery.push(...buildDiscoveryTexts(record, parsed));
      const configuredAliases = Array.isArray(record.metadata?.legacy_aliases)
        ? record.metadata.legacy_aliases
        : [record.sourceId];
      for (const aliasId of new Set([record.sourceId, ...configuredAliases].map(String))) {
        aliases.push({ aliasId, sourceId: record.sourceId, answerUnitId: parsed.units[0]?.answerUnitId || null });
      }
    }
    return {
      answerUnits,
      passages: passages.sort((left, right) => left.text.length - right.text.length),
      discovery: discovery.sort((left, right) => left.text.length - right.text.length),
      aliases,
    };
  }

  async function embedAndStagePassages(job, config, indexClient, tableName, rows, batchSize) {
    async function embedBatch(batch, singlePassageAttempt = 0) {
      throwIfCancelled(job);
      try {
        return await embed({
          baseUrl: config.ollamaBaseUrl,
          model: config.model,
          texts: batch.map((passage) => buildPassageEmbeddingText(passage.text, {
            model: config.model,
            formatVersion: config.embeddingFormatVersion,
          })),
          timeoutMs: 300000,
        });
      } catch (error) {
        if (!isRetriableEmbeddingError(error)) throw error;
        if (batch.length > 1) {
          const midpoint = Math.ceil(batch.length / 2);
          log(job, `Embedding batch was interrupted; retrying it as ${midpoint} + ${batch.length - midpoint} passages.`);
          const left = await embedBatch(batch.slice(0, midpoint));
          const right = await embedBatch(batch.slice(midpoint));
          return [...left, ...right];
        }
        if (singlePassageAttempt < MAX_SINGLE_PASSAGE_RETRIES) {
          log(job, `Embedding passage ${batch[0]?.sourceId}:${batch[0]?.passageIndex} was interrupted; retrying (${singlePassageAttempt + 1}/${MAX_SINGLE_PASSAGE_RETRIES}).`);
          return embedBatch(batch, singlePassageAttempt + 1);
        }
        throw error;
      }
    }

    for (let index = 0; index < rows.length; index += batchSize) {
      throwIfCancelled(job);
      const batch = rows.slice(index, index + batchSize);
      let vectors;
      try {
        vectors = await embedBatch(batch);
      } catch (error) {
        const first = batch[0];
        throw new Error(
          `Embedding failed for answer passage ${first?.sourceId}:${first?.passageIndex}: ${sanitizeError(error)}`,
        );
      }
      const staged = batch.map((passage, vectorIndex) => ({
        ...passage,
        embedding: vectors[vectorIndex],
      }));
      await db.insertStagePassages(indexClient, tableName, staged);
      job.passages += staged.length;
    }
  }

  async function embedAndStageDiscovery(job, config, indexClient, tableName, rows, batchSize) {
    for (let index = 0; index < rows.length; index += batchSize) {
      throwIfCancelled(job);
      const batch = rows.slice(index, index + batchSize);
      const vectors = await embed({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        texts: batch.map((item) => buildPassageEmbeddingText(item.text, {
          model: config.model,
          formatVersion: config.embeddingFormatVersion,
        })),
        timeoutMs: 300000,
      });
      await db.insertStageDiscoveryPassages(indexClient, tableName, batch.map((item, vectorIndex) => ({
        ...item,
        embedding: vectors[vectorIndex],
      })));
      job.discoveryPassages += batch.length;
    }
  }

  async function run(job, config) {
    let sourceSnapshot;
    let indexPool;
    let indexClient;
    let stageNames;
    try {
      log(job, `Testing Ollama model ${config.model}...`);
      const modelInfo = await probe({ baseUrl: config.ollamaBaseUrl, model: config.model });
      const dimension = Number(modelInfo.dimension);
      config.embeddingModelDigest = modelInfo.digest || null;
      config.embeddingFormatVersion = embeddingFormatForModel(config.model);

      indexPool = db.createPool(config.indexConnection);
      indexClient = await indexPool.connect();
      await db.ensureCoreSchema(indexClient);
      const corpus = await db.getCorpus(indexClient);
      if (!corpus) throw new Error('Index is not initialized. Initialize it from the Index screen first.');
      if (job.mode === 'incremental' &&
          (corpus.embeddingModel !== config.model || Number(corpus.embeddingDimension) !== dimension ||
           corpus.embeddingFormatVersion !== config.embeddingFormatVersion ||
           String(corpus.embeddingModelDigest || '') !== String(config.embeddingModelDigest || ''))) {
        throw new Error('Embedding model, digest, dimension, or embedding format changed; run a full rebuild.');
      }
      if (job.mode === 'incremental' && corpus.retrievalSchemaVersion !== RETRIEVAL_SCHEMA_VERSION) {
        throw new Error('Retrieval index format changed; run a full rebuild.');
      }

      await db.createSyncRun(indexClient, job);
      stageNames = await db.createSyncStage(indexClient, job.id, dimension);
      sourceSnapshot = await db.openSourceSnapshot(config.sourceConnection, config.mapping);
      const normalizedMapping = sourceSnapshot.mapping;
      job.total = sourceSnapshot.total;
      await db.updateSyncRun(indexClient, job);
      
      log(job, `Validated ${job.total} source records.`);

      const fetchSize = Math.max(25, Math.min(1000, Number(config.fetchSize || 250)));
      const embeddingBatchSize = Math.max(1, Math.min(64, Number(config.embeddingBatchSize || 32)));

      for (let offset = 0; offset < job.total; offset += fetchSize) {
        throwIfCancelled(job);
        const records = await sourceSnapshot.readBatch(offset, fetchSize);
        await db.insertSeen(indexClient, stageNames.seen, records.map((record) => record.sourceId));
        const hashed = records.map((record) => ({ ...record, contentHash: contentHash(record) }));
        const existing = job.mode === 'rebuild'
          ? new Map()
          : await db.getExistingHashes(indexClient, hashed.map((record) => record.sourceId));
        const changed = hashed.filter((record) => existing.get(record.sourceId) !== record.contentHash);

        for (let index = 0; index < changed.length; index += embeddingBatchSize) {
          throwIfCancelled(job);
          const batch = changed.slice(index, index + embeddingBatchSize);
          // v4 searches answer-passage vectors exclusively. Keep a valid placeholder
          // in the snapshot table instead of embedding the same answer twice.
          const recordEmbedding = placeholderRecordEmbedding(dimension);
          const staged = batch.map((record) => ({ ...record, embedding: recordEmbedding }));
          await db.insertStageRecords(indexClient, stageNames.stage, staged);
          job.changed += staged.length;
        }
        const structured = structuralRows(changed, job);
        await db.insertStageAnswerUnits(indexClient, stageNames.answerUnits, structured.answerUnits);
        await db.insertStageAliases(indexClient, stageNames.aliases, structured.aliases);
        await embedAndStagePassages(
          job,
          config,
          indexClient,
          stageNames.passages,
          structured.passages,
          embeddingBatchSize,
        );
        await embedAndStageDiscovery(job, config, indexClient, stageNames.discovery, structured.discovery, embeddingBatchSize);

        job.processed += records.length;
        await db.updateSyncRun(indexClient, job);
        publish(job, 'progress');
      }

      await sourceSnapshot.close(true);
      sourceSnapshot = null;
      throwIfCancelled(job);
      log(job, job.mode === 'rebuild' ? 'Committing rebuilt index...' : 'Committing incremental changes...');
      const commitPayload = {
        names: stageNames,
        mapping: normalizedMapping,
        model: config.model,
        modelDigest: config.embeddingModelDigest,
        dimension,
        formatVersion: config.embeddingFormatVersion,
        retrievalVersion: RETRIEVAL_SCHEMA_VERSION,
        ollamaBaseUrl: config.ollamaBaseUrl,
        total: job.total,
      };
      if (job.mode === 'rebuild') await db.commitRebuild(indexClient, commitPayload);
      else await db.commitIncremental(indexClient, commitPayload);
      stageNames = null;
      try { clearIdfCache(); } catch { /* ignore */ }

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      log(job, `Indexed ${job.total} documents; ${job.changed} changed, ${job.passages} citable answer passages, ${job.discoveryPassages} discovery passages, and ${job.ambiguousDocuments} ambiguous documents excluded from citations.`);
      await db.updateSyncRun(indexClient, job);
    } catch (error) {
      job.status = error?.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed';
      job.error = sanitizeError(error);
      job.finishedAt = new Date().toISOString();
      log(job, job.error);
      if (sourceSnapshot) await sourceSnapshot.close(false).catch(() => undefined);
      if (indexClient && stageNames) await db.dropSyncStage(indexClient, stageNames).catch(() => undefined);
      if (indexClient) await db.updateSyncRun(indexClient, job).catch(() => undefined);
    } finally {
      if (indexClient) indexClient.release();
      if (indexPool) await indexPool.end().catch(() => undefined);
      config.sourceConnection = null;
      config.indexConnection = null;
      publish(job, 'status');
      for (const listener of [...job.listeners]) {
        try { listener.end(); } catch { /* ignore */ }
      }
      job.listeners.clear();
    }
  }

  function start(config) {
    assertRoleAwareUniversalSource(config);
    const active = [...jobs.values()].find((job) => ['queued', 'running'].includes(job.status));
    if (active) {
      const error = new Error(`Synchronization ${active.id} is already running`);
      error.code = 'SYNC_ACTIVE';
      throw error;
    }
    const job = {
      id: `sync_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      mode: config.mode,
      status: 'queued',
      processed: 0,
      changed: 0,
      passages: 0,
      discoveryPassages: 0,
      ambiguousDocuments: 0,
      total: 0,
      error: null,
      logs: [],
      listeners: new Set(),
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    jobs.set(job.id, job);
    queueMicrotask(() => {
      job.status = 'running';
      publish(job);
      void run(job, config);
    });
    return publicJob(job);
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (['queued', 'running'].includes(job.status)) job.cancelRequested = true;
    return publicJob(job);
  }

  function subscribe(jobId, response) {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.listeners.add(response);
    response.write(`event: status\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    return true;
  }

  function unsubscribe(jobId, response) {
    jobs.get(jobId)?.listeners.delete(response);
  }

  return { start, get, cancel, subscribe, unsubscribe, _jobs: jobs };
}

module.exports = { assertRoleAwareUniversalSource, connectionDatabase, createSyncManager, publicJob, sanitizeError };
