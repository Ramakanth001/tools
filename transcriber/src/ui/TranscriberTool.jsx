import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './transcriber.css';

const STANDALONE_RUNTIME = {
  toolId: 'transcriber',
  apiBasePath: '/api',
  homePath: '/',
  logsPath: '/logs',
  storagePrefix: 'transcriber.standalone',
};

const MODEL_OPTIONS = [
  ['tiny', 'Tiny — fastest, least accurate'],
  ['base', 'Base — fast and compact'],
  ['small', 'Small — recommended local default'],
  ['medium', 'Medium — slower, higher accuracy'],
  ['large', 'Large-v3 — best Whisper accuracy'],
  ['turbo', 'Turbo — fast large-model transcription'],
];

const QWEN_MODEL = 'qwen3-asr-1.7b';

const LANGUAGE_OPTIONS = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['te', 'Telugu'],
  ['ta', 'Tamil'],
  ['kn', 'Kannada'],
  ['ml', 'Malayalam'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
];

const ACTIVE_STATUSES = new Set(['queued', 'running']);

function joinPath(base, suffix) {
  return `${String(base || '/api').replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
}

function getAuthToken() {
  if (typeof window === 'undefined') return '';
  const fromUrl = new URLSearchParams(window.location.search).get('token') || '';
  if (fromUrl) localStorage.setItem('tools.authToken', fromUrl);
  return fromUrl || localStorage.getItem('tools.authToken') || '';
}

function withAuthQuery(url) {
  const token = getAuthToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

async function request(runtime, suffix, { method = 'GET', body } = {}) {
  const token = getAuthToken();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(joinPath(runtime.apiBasePath, suffix), {
    method,
    headers: {
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'x-tools-auth': token } : {}),
    },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || 'Request failed');
  return payload;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const value = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`;
}

function statusClass(status) {
  if (status === 'done') return 'good';
  if (status === 'error') return 'bad';
  if (status === 'running') return 'active';
  return '';
}

function engineLabel(job) {
  return job?.engine === 'qwen3-asr' ? 'Qwen3-ASR 1.7B' : `Whisper ${job?.model || ''}`.trim();
}

function Diagnostics({ report, loading, onRefresh }) {
  const checks = Object.entries(report?.checks || {});
  return (
    <div className="card transcriber-diagnostics">
      <div className="transcriber-section-title">
        <div>
          <h3>Local runtime</h3>
          <div className="hint">Whisper runs on this machine; model weights download once and stay in the local cache.</div>
        </div>
        <button className="btn" type="button" onClick={onRefresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button>
      </div>
      <div className="transcriber-checks">
        {checks.length ? checks.map(([name, check]) => (
          <div className="transcriber-check" key={name}>
            <span className={`transcriber-dot ${check.ok ? 'ok' : 'error'}`} />
            <div>
              <strong>{name}</strong>
              <div className="hint">{check.ok ? (check.version || check.path || check.name || 'Ready') : (check.error || 'Unavailable')}</div>
            </div>
          </div>
        )) : <div className="hint">Run diagnostics to verify Python, Whisper, FFmpeg, and FFprobe.</div>}
      </div>
      {report ? (
        <div className="transcriber-runtime-summary">
          <span className={`badge ${report.ready ? '' : 'danger'}`}>{report.ready ? 'Ready' : 'Setup required'}</span>
          <span className="hint">Device: {report.device || 'unknown'}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function TranscriberTool({ runtime: runtimeProp }) {
  const runtime = useMemo(() => ({ ...STANDALONE_RUNTIME, ...(runtimeProp || {}) }), [runtimeProp]);
  const [health, setHealth] = useState(null);
  const [healthBusy, setHealthBusy] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [currentJob, setCurrentJob] = useState(null);
  const [file, setFile] = useState(null);
  const [operation, setOperation] = useState('transcribe');
  const [engine, setEngine] = useState('whisper');
  const [model, setModel] = useState('small');
  const [chunkMinutes, setChunkMinutes] = useState(10);
  const [language, setLanguage] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const fileInputRef = useRef(null);
  const eventSourceRef = useRef(null);
  const logRef = useRef(null);

  const loadHealth = useCallback(async () => {
    setHealthBusy(true);
    try {
      setHealth(await request(runtime, '/health'));
    } catch (healthError) {
      setHealth({ ready: false, checks: { api: { ok: false, error: healthError.message } }, device: 'unknown' });
    } finally {
      setHealthBusy(false);
    }
  }, [runtime]);

  const loadJobs = useCallback(async () => {
    try {
      const payload = await request(runtime, '/jobs?limit=50');
      setJobs(payload.jobs || []);
    } catch (jobsError) {
      setError(jobsError.message);
    }
  }, [runtime]);

  const loadPreview = useCallback(async (job) => {
    if (job?.status !== 'done' || !job.artifacts?.txt) return setPreview('');
    try {
      const token = getAuthToken();
      const response = await fetch(joinPath(runtime.apiBasePath, `/jobs/${encodeURIComponent(job.id)}/artifacts/txt`), {
        headers: token ? { 'x-tools-auth': token } : {},
      });
      if (response.ok) setPreview(await response.text());
    } catch {
      setPreview('');
    }
  }, [runtime]);

  const followJob = useCallback((jobId) => {
    eventSourceRef.current?.close();
    const source = new EventSource(withAuthQuery(joinPath(runtime.apiBasePath, `/jobs/${encodeURIComponent(jobId)}/events`)));
    eventSourceRef.current = source;
    source.addEventListener('job', (event) => {
      const next = JSON.parse(event.data);
      setCurrentJob(next);
      setJobs((existing) => [next, ...existing.filter((job) => job.id !== next.id)]);
      if (!ACTIVE_STATUSES.has(next.status)) {
        source.close();
        setBusy(false);
        void loadPreview(next);
      }
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setBusy(false);
    };
  }, [loadPreview, runtime]);

  useEffect(() => {
    void loadHealth();
    void loadJobs();
    return () => eventSourceRef.current?.close();
  }, [loadHealth, loadJobs]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [currentJob?.logs?.length]);

  async function start() {
    if (!file) return setError('Choose an audio or video file first.');
    const chunkSeconds = Math.round(Number(chunkMinutes) * 60);
    if (operation === 'transcribe' && (!Number.isInteger(chunkSeconds) || chunkSeconds < 60 || chunkSeconds > 3600)) {
      return setError('Choose a chunk length between 1 and 60 minutes.');
    }
    setBusy(true);
    setError('');
    setPreview('');
    try {
      const body = new FormData();
      body.append('media', file);
      body.append('operation', operation);
      body.append('engine', engine);
      body.append('model', model);
      body.append('chunkSeconds', String(chunkSeconds));
      body.append('language', language);
      const payload = await request(runtime, '/jobs', { method: 'POST', body });
      setCurrentJob(payload.job);
      setJobs((existing) => [payload.job, ...existing.filter((job) => job.id !== payload.job.id)]);
      followJob(payload.jobId);
    } catch (startError) {
      setError(startError.message);
      setBusy(false);
    }
  }

  async function cancel() {
    if (!currentJob) return;
    try {
      const payload = await request(runtime, `/jobs/${encodeURIComponent(currentJob.id)}/cancel`, { method: 'POST', body: {} });
      setCurrentJob(payload.job);
    } catch (cancelError) {
      setError(cancelError.message);
    }
  }

  async function remove(job) {
    try {
      await request(runtime, `/jobs/${encodeURIComponent(job.id)}/delete`, { method: 'POST', body: {} });
      setJobs((existing) => existing.filter((item) => item.id !== job.id));
      if (currentJob?.id === job.id) {
        setCurrentJob(null);
        setPreview('');
      }
    } catch (deleteError) {
      setError(deleteError.message);
    }
  }

  function artifactUrl(job, kind) {
    return withAuthQuery(joinPath(runtime.apiBasePath, `/jobs/${encodeURIComponent(job.id)}/artifacts/${kind}`));
  }

  const progress = Math.max(0, Math.min(100, Number(currentJob?.progress?.percent) || 0));
  const running = ACTIVE_STATUSES.has(currentJob?.status);
  const extractingAudio = operation === 'extract_audio';

  return (
    <div className="transcriber-tool">
      {error ? <div className="transcriber-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')}>Dismiss</button></div> : null}

      <Diagnostics report={health} loading={healthBusy} onRefresh={loadHealth} />

      <div className="transcriber-layout">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>New transcription</h3>
              <div className="hint">Audio and video are processed locally and removed after the job finishes.</div>
            </div>
            <span className="badge">Whisper</span>
          </div>
          <div className="panel-body transcriber-form">
            <div
              className={`transcriber-dropzone ${dragging ? 'dragging' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const dropped = event.dataTransfer.files?.[0];
                if (dropped) setFile(dropped);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*"
                hidden
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
              <div className="transcriber-upload-icon" aria-hidden="true">↑</div>
              {file ? (
                <div><strong>{file.name}</strong><div className="hint">{formatBytes(file.size)} · click to replace</div></div>
              ) : (
                <div><strong>Drop media here or choose a file</strong><div className="hint">Maximum {formatBytes(health?.maxUploadBytes || 2 * 1024 ** 3)}</div></div>
              )}
            </div>

            <div className="transcriber-field-grid">
              <label>
                <span>Task</span>
                <select value={operation} onChange={(event) => setOperation(event.target.value)} disabled={running}>
                  <option value="transcribe">Transcribe media</option>
                  <option value="extract_audio">Extract audio from video (MP3)</option>
                </select>
              </label>
              {operation === 'transcribe' ? <label>
                <span>Engine</span>
                <select value={engine} onChange={(event) => {
                  const next = event.target.value;
                  setEngine(next);
                  setModel(next === 'qwen3-asr' ? QWEN_MODEL : 'large');
                }} disabled={running}>
                  <option value="whisper">Whisper — local, broad compatibility</option>
                  <option value="qwen3-asr">Qwen3-ASR 1.7B — quality-first</option>
                </select>
              </label> : <div className="transcriber-extraction-note">Creates a high-quality MP3 from the first audio stream. No transcription model is loaded.</div>}
            </div>

            {operation === 'transcribe' ? <div className="transcriber-field-grid">
              <label>
                <span>Model</span>
                <select value={model} onChange={(event) => setModel(event.target.value)} disabled={running}>
                  {(engine === 'qwen3-asr' ? [[QWEN_MODEL, 'Qwen3-ASR 1.7B — highest quality, high memory']] : MODEL_OPTIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>Language</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={running}>
                  {LANGUAGE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>Chunk length (minutes)</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  step="1"
                  value={chunkMinutes}
                  onChange={(event) => setChunkMinutes(event.target.value)}
                  disabled={running}
                />
                <span className="hint">10 is a balanced default; shorter lowers memory use.</span>
              </label>
            </div> : null}

            <div className="toolbar">
              <button className="btn primary" type="button" onClick={start} disabled={busy || !file || healthBusy || health?.ready === false}>
                {busy ? (extractingAudio ? 'Extracting audio…' : 'Transcribing…') : (extractingAudio ? 'Extract audio' : 'Start transcription')}
              </button>
              {running ? <button className="btn danger" type="button" onClick={cancel}>Cancel</button> : null}
            </div>

            {currentJob ? (
              <div className="transcriber-current">
                <div className="transcriber-job-heading">
                  <div><strong>{currentJob.originalName}</strong><div className="hint">{currentJob.operation === 'extract_audio' ? 'MP3 audio extraction' : `${engineLabel(currentJob)} · ${currentJob.language === 'auto' ? 'auto language' : currentJob.language} · ${Math.round((currentJob.chunkSeconds || 600) / 60)}m chunks`}</div></div>
                  <span className={`transcriber-status ${statusClass(currentJob.status)}`}>{currentJob.status}</span>
                </div>
                <div className="transcriber-progress" aria-label={`${progress}% complete`}>
                  <div style={{ width: `${progress}%` }} />
                </div>
                <div className="transcriber-progress-meta">
                  <span>{currentJob.progress?.phase?.replaceAll('_', ' ') || currentJob.status}</span>
                  <span>{currentJob.progress?.totalChunks ? `Chunk ${currentJob.progress.currentChunk}/${currentJob.progress.totalChunks}` : `${progress}%`}</span>
                </div>
                {currentJob.error ? <div className="transcriber-inline-error">{currentJob.error}</div> : null}
                {currentJob.status === 'done' ? (
                  <div className="toolbar">
                    {currentJob.artifacts?.audio ? <a className="btn primary" href={artifactUrl(currentJob, 'audio')}>Download MP3</a> : null}
                    {currentJob.artifacts?.txt ? <a className="btn primary" href={artifactUrl(currentJob, 'txt')}>Download TXT</a> : null}
                    {currentJob.artifacts?.srt ? <a className="btn" href={artifactUrl(currentJob, 'srt')}>Download SRT</a> : null}
                    <span className="hint">{formatDuration(currentJob.durationSeconds)}{currentJob.operation === 'transcribe' ? ` · ${currentJob.segments || 0} segments · ${currentJob.device}` : ''}</span>
                  </div>
                ) : null}
                <details className="transcriber-logs" open={running}>
                  <summary>Job log ({currentJob.logs?.length || 0})</summary>
                  <pre ref={logRef}>{(currentJob.logs || []).join('\n') || 'Waiting for worker output…'}</pre>
                </details>
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div><h3>Transcript</h3><div className="hint">Preview and copy the completed plain-text artifact.</div></div>
            {preview ? <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(preview)}>Copy</button> : null}
          </div>
          <div className="panel-body">
            <div className={`transcriber-preview ${preview ? '' : 'empty'}`}>
              {preview || 'Your transcript will appear here when the current job completes.'}
            </div>
          </div>
        </div>
      </div>

      <div className="panel transcriber-history">
        <div className="panel-header">
          <div><h3>Job history</h3><div className="hint">Artifacts stay local until you delete their job.</div></div>
          <button className="btn" type="button" onClick={loadJobs}>Refresh</button>
        </div>
        <div className="panel-body">
          {jobs.length ? (
            <div className="transcriber-job-list">
              {jobs.map((job) => (
                <div className="transcriber-job-row" key={job.id}>
                  <button className="transcriber-job-select" type="button" onClick={async () => {
                    try {
                      const payload = await request(runtime, `/jobs/${encodeURIComponent(job.id)}`);
                      setCurrentJob(payload.job);
                      await loadPreview(payload.job);
                      if (ACTIVE_STATUSES.has(payload.job.status)) followJob(payload.job.id);
                    } catch (jobError) { setError(jobError.message); }
                  }}>
                    <strong>{job.originalName}</strong>
                    <span className="hint">{new Date(job.createdAt).toLocaleString()} · {formatBytes(job.mediaBytes)} · {job.operation === 'extract_audio' ? 'MP3 extraction' : engineLabel(job)}</span>
                  </button>
                  <span className={`transcriber-status ${statusClass(job.status)}`}>{job.status}</span>
                  <div className="toolbar">
                    {job.artifacts?.txt ? <a className="btn" href={artifactUrl(job, 'txt')}>TXT</a> : null}
                    {job.artifacts?.srt ? <a className="btn" href={artifactUrl(job, 'srt')}>SRT</a> : null}
                    {job.artifacts?.audio ? <a className="btn" href={artifactUrl(job, 'audio')}>MP3</a> : null}
                    {!ACTIVE_STATUSES.has(job.status) ? <button className="btn danger" type="button" onClick={() => remove(job)}>Delete</button> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="transcriber-empty">No transcription jobs yet.</div>}
        </div>
      </div>
    </div>
  );
}
