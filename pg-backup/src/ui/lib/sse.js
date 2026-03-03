export function openJobEventSource(jobId, { onLog, onProgress, onStatus } = {}) {
  const ev = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);

  ev.addEventListener('log', (e) => {
    try {
      onLog?.(JSON.parse(e.data));
    } catch {
      onLog?.(String(e.data));
    }
  });

  ev.addEventListener('progress', (e) => {
    try {
      onProgress?.(JSON.parse(e.data));
    } catch {
      // ignore
    }
  });

  ev.addEventListener('status', (e) => {
    try {
      onStatus?.(JSON.parse(e.data));
    } catch {
      // ignore
    }
  });

  ev.addEventListener('error', () => {
    // Let callers decide; close to avoid infinite reconnect loops.
    try {
      ev.close();
    } catch {
      // ignore
    }
  });

  return ev;
}
