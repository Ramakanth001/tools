const crypto = require('node:crypto');
const database = require('./database');
const { buildEmbeddingText, contentHash } = require('./core');
const { embedTexts, testOllama } = require('./ollama');

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

  async function embedWithRecordErrors(config, records) {
    if (!records.length) return [];
    try {
      return await embed({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        texts: records.map((record) => buildEmbeddingText(record.question, record.answer)),
        timeoutMs: 300000,
      });
    } catch (batchError) {
      if (records.length === 1) {
        throw new Error(`Embedding failed for source record ${records[0].sourceId}: ${sanitizeError(batchError)}`);
      }
      const failures = [];
      const recovered = [];
      for (const record of records) {
        try {
          const [vector] = await embed({
            baseUrl: config.ollamaBaseUrl,
            model: config.model,
            texts: [buildEmbeddingText(record.question, record.answer)],
            timeoutMs: 300000,
          });
          recovered.push(vector);
        } catch (error) {
          failures.push(`${record.sourceId} (${sanitizeError(error)})`);
          if (failures.length >= 5) break;
        }
      }
      if (failures.length) throw new Error(`Embedding failed for source records: ${failures.join(', ')}`);
      return recovered;
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

      indexPool = db.createPool(config.indexConnection);
      indexClient = await indexPool.connect();
      await db.ensureCoreSchema(indexClient);
      const corpus = await db.getCorpus(indexClient);
      if (!corpus) throw new Error('Index is not initialized. Initialize it from the Index screen first.');
      if (job.mode === 'incremental' &&
          (corpus.embeddingModel !== config.model || Number(corpus.embeddingDimension) !== dimension)) {
        throw new Error('Embedding model or dimension changed; run a full rebuild.');
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
          const vectors = await embedWithRecordErrors(config, batch);
          const staged = batch.map((record, vectorIndex) => ({ ...record, embedding: vectors[vectorIndex] }));
          await db.insertStageRecords(indexClient, stageNames.stage, staged);
          job.changed += staged.length;
        }

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
        dimension,
        ollamaBaseUrl: config.ollamaBaseUrl,
        total: job.total,
      };
      if (job.mode === 'rebuild') await db.commitRebuild(indexClient, commitPayload);
      else await db.commitIncremental(indexClient, commitPayload);
      stageNames = null;

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      log(job, `Indexed ${job.total} records; ${job.changed} embeddings written.`);
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

module.exports = { createSyncManager, publicJob, sanitizeError };
