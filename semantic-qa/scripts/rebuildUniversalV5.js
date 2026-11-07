const { createSyncManager } = require('../src/syncManager');
const { indexConnection, mapping, sourceConnection } = require('./universalV5Config');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  const mode = process.argv.includes('--incremental') ? 'incremental' : 'rebuild';
  const manager = createSyncManager();
  const job = manager.start({
    sourceConnection,
    indexConnection,
    mapping,
    mode,
    ollamaBaseUrl: process.env.UNIVERSAL_OLLAMA_URL || 'http://127.0.0.1:11434',
    model: process.env.UNIVERSAL_EMBEDDING_MODEL || 'embeddinggemma',
    fetchSize: Number(process.env.UNIVERSAL_SYNC_FETCH_SIZE || 250),
    embeddingBatchSize: Number(process.env.UNIVERSAL_EMBEDDING_BATCH_SIZE || 64),
  });
  process.stdout.write(mode === 'rebuild'
    ? `Started ${job.id}. The active index will not change until atomic promotion.\n`
    : `Started ${job.id}. Only changed documents will be replaced atomically.\n`);
  const stop = () => manager.cancel(job.id);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let lastSignature = '';
  while (true) {
    const current = manager.get(job.id);
    const signature = [current.status, current.processed, current.total, current.changed, current.passages, current.discoveryPassages, current.error].join('|');
    if (signature !== lastSignature) {
      process.stdout.write(`${JSON.stringify({
        status: current.status,
        processed: current.processed,
        total: current.total,
        changed: current.changed,
        answerPassages: current.passages,
        discoveryPassages: current.discoveryPassages,
        ambiguousDocuments: current.ambiguousDocuments,
        percent: current.percent,
        error: current.error,
      })}\n`);
      lastSignature = signature;
    }
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      if (current.status !== 'completed') process.exitCode = 1;
      return;
    }
    await wait(2000);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
