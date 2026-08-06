import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, LOCAL_DEMO_SETTINGS, UNIVERSAL_QA_SETTINGS, mergeSettings, stripSecrets } from './settings.mjs';
import './semantic-qa.css';

const STANDALONE_RUNTIME = {
  toolId: 'semantic-qa',
  apiBasePath: '/api',
  homePath: '/',
  storagePrefix: 'semantic-qa.standalone',
};

function joinPath(base, path) {
  return `${String(base || '/api').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function getAuthToken() {
  const fromUrl = new URLSearchParams(window.location.search).get('token') || '';
  if (fromUrl) localStorage.setItem('tools.authToken', fromUrl);
  return fromUrl || localStorage.getItem('tools.authToken') || '';
}

function authQuery(url) {
  const token = getAuthToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

async function api(runtime, path, { body, method = 'POST', timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = getAuthToken();
  try {
    const response = await fetch(joinPath(runtime.apiBasePath, path), {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'x-tools-auth': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const message = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error || response.statusText);
      throw new Error(message || 'Request failed');
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function connectionConfigured(connection) {
  return Boolean(String(connection?.connectionString || '').trim() ||
    (String(connection?.host || '').trim() && String(connection?.user || '').trim() && String(connection?.database || '').trim()));
}

function mappingConfigured(mapping) {
  return Boolean(mapping?.schema && mapping?.table && mapping?.idColumn && mapping?.questionColumn && mapping?.answerColumn);
}

function DiagnosticRow({ label, check, pendingText }) {
  const status = check?.status || 'unknown';
  const text = status === 'ready'
    ? (label === 'Index PostgreSQL' && !check.details?.vectorVersion ? 'Connected; pgvector is not enabled yet' : 'Ready')
    : status === 'error' ? check.error : status === 'not_configured' ? check.error : pendingText;
  return (
    <div className="qa-diagnostic-row">
      <span className={`qa-status-dot ${status}`} aria-hidden="true" />
      <div><strong>{label}</strong><div className="hint">{text}</div></div>
      <span className="badge">{status.replace('_', ' ')}</span>
    </div>
  );
}

function SetupScreen({ runtime, settings, onNavigate, onLoadDemo, onLoadUniversal }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const diagnose = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await api(runtime, '/diagnostics', {
        body: {
          sourceConnection: settings.sourceConnection,
          indexConnection: settings.indexConnection,
          ollamaBaseUrl: settings.ollamaBaseUrl,
          model: settings.model,
          summaryModel: settings.summaryModel,
        },
        timeoutMs: 180000,
      }));
    } catch (diagnosticError) {
      setError(diagnosticError.message);
    } finally { setBusy(false); }
  };

  const mappingReady = mappingConfigured(settings.mapping);
  const loadDemo = () => {
    onLoadDemo();
    setReport(null);
    setError('');
  };
  return (
    <div className="qa-stack">
      <div className="card qa-onboarding">
        <div className="qa-card-title">
          <div><h3>Make the retrieval pipeline ready</h3><div className="hint">The local demo supplies a sample corpus; Ollama and PostgreSQL still run as real services.</div></div>
          <div className="toolbar">
            <button className="btn" onClick={loadDemo} disabled={busy}>Load sample demo</button>
            <button className="btn" onClick={() => { onLoadUniversal(); setReport(null); setError(''); }} disabled={busy}>Load universal Q&A</button>
            <button className="btn primary" onClick={diagnose} disabled={busy}>{busy ? 'Checking…' : 'Run diagnostics'}</button>
          </div>
        </div>
        {error ? <div className="alert warn" style={{ marginTop: 14 }}>{error}</div> : null}
        <div className="qa-diagnostics">
          <DiagnosticRow label="Tool API" check={report?.checks?.api} pendingText="Run diagnostics to verify" />
          <DiagnosticRow label="Ollama + embedding model" check={report?.checks?.ollama} pendingText="Requires a running Ollama service" />
          <DiagnosticRow label="Ollama + summary model" check={report?.checks?.summaryModel} pendingText="Required for synthesized answers" />
          <DiagnosticRow label="Source PostgreSQL" check={report?.checks?.sourceDatabase} pendingText="Requires Q&A credentials, or load the local demo" />
          <DiagnosticRow label="Index PostgreSQL" check={report?.checks?.indexDatabase} pendingText="Requires a writable database, or load the local demo" />
          <div className="qa-diagnostic-row">
            <span className={`qa-status-dot ${mappingReady ? 'ready' : 'not_configured'}`} aria-hidden="true" />
            <div><strong>Corpus field mapping</strong><div className="hint">{mappingReady ? `${settings.mapping.schema}.${settings.mapping.table}` : 'Choose ID, question, and answer columns in Settings'}</div></div>
            <span className="badge">{mappingReady ? 'ready' : 'not configured'}</span>
          </div>
        </div>
      </div>

      <div className="qa-setup-grid">
        <div className="card"><span className="qa-step-number">1</span><h3>Install and start Ollama</h3><pre className="qa-command">brew install ollama{`\n`}brew services start ollama{`\n`}ollama pull {settings.model}{`\n`}ollama pull {settings.summaryModel}</pre><div className="hint">The embedding model finds answer passages; the summary model writes a grounded synthesis from accepted passages only.</div></div>
        <div className="card"><span className="qa-step-number">2</span><h3>Connect both databases</h3><div className="hint">The source account is read-only. The index account must be able to create the vector extension, schema, tables, and index.</div><button className="btn" style={{ marginTop: 12 }} onClick={() => onNavigate('settings')}>Open Settings</button></div>
        <div className="card"><span className="qa-step-number">3</span><h3>Map the corpus</h3><div className="hint">Discover the source catalog and select a unique ID, question, answer, and optional metadata/order fields.</div><button className="btn" style={{ marginTop: 12 }} onClick={() => onNavigate('settings')}>Configure mapping</button></div>
        <div className="card"><span className="qa-step-number">4</span><h3>Build the index</h3><div className="hint">Initialize pgvector, then run Full rebuild once. Later source changes can use Incremental sync.</div><button className="btn" style={{ marginTop: 12 }} onClick={() => onNavigate('index')}>Open Index</button></div>
      </div>
    </div>
  );
}

function ConnectionFields({ value, onChange, label }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  return (
    <div className="qa-connection">
      <div className="section-title">{label}</div>
      <label className="field full">
        <span className="field-label">Connection string (kept in memory only)</span>
        <input type="password" autoComplete="off" value={value.connectionString} onChange={(event) => set('connectionString', event.target.value)} placeholder="postgresql://user:password@host:5432/database" />
      </label>
      <div className="form-grid">
        <label className="field" style={{ gridColumn: 'span 4' }}><span className="field-label">Host</span><input value={value.host} onChange={(event) => set('host', event.target.value)} /></label>
        <label className="field" style={{ gridColumn: 'span 2' }}><span className="field-label">Port</span><input type="number" value={value.port} onChange={(event) => set('port', Number(event.target.value))} /></label>
        <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Database</span><input value={value.database} onChange={(event) => set('database', event.target.value)} /></label>
        <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">SSL mode</span><select value={value.sslMode} onChange={(event) => set('sslMode', event.target.value)}><option value="disable">disable</option><option value="prefer">prefer</option><option value="require">require</option><option value="verify-full">verify-full</option><option value="no-verify">no-verify</option></select></label>
        <label className="field"><span className="field-label">User</span><input value={value.user} onChange={(event) => set('user', event.target.value)} /></label>
        <label className="field"><span className="field-label">Password (kept in memory only)</span><input type="password" autoComplete="off" value={value.password} onChange={(event) => set('password', event.target.value)} /></label>
      </div>
    </div>
  );
}

function StatusMessage({ status }) {
  if (!status?.message) return null;
  return <div className={`alert ${status.kind === 'error' ? 'warn' : ''}`}>{status.message}</div>;
}

function sameMatch(left, right) {
  if (!left || !right) return false;
  if (left.sourceId != null && right.sourceId != null) {
    return String(left.sourceId) === String(right.sourceId);
  }
  return left.relevanceRank === right.relevanceRank &&
    left.question === right.question &&
    left.answer === right.answer;
}

function MatchRecord({ match, label }) {
  return (
    <article className="card qa-answer">
      <div className="qa-answer-head">
        <div>
          <span className="badge">{label}</span>
          {match.relevanceRank != null ? <span className="badge">#{match.relevanceRank}</span> : null}
          <span className="badge">Relevance {Number(match.relevanceScore ?? match.similarity).toFixed(3)}</span>
          {match.relevanceScore != null ? <span className="badge">Cosine {Number(match.similarity).toFixed(3)}</span> : null}
        </div>
        <span className="mono">Record {match.sourceId}</span>
      </div>
      <div className="qa-stored-question">{match.question}</div>
      {match.matchedPassages?.[0] ? (
        <div className="qa-matched-passage">
          <div className="section-title">Best matching answer passage</div>
          <div className="qa-summary-text">{match.matchedPassages[0].text}</div>
          <div className="hint">Passage meaning {Number(match.matchedPassages[0].semanticSimilarity).toFixed(3)} · stored title/question had zero ranking weight</div>
        </div>
      ) : null}
      <div className="section-title">Complete stored answer</div>
      <div className="qa-verbatim">{match.answer}</div>
      {match.metadata && Object.keys(match.metadata).length ? (
        <dl className="qa-metadata">
          {Object.entries(match.metadata)
            .filter(([key]) => key !== 'source_context')
            .map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{value == null ? '—' : String(value)}</dd></React.Fragment>)}
        </dl>
      ) : null}
      {match.sourceGroup != null || match.sourceOrder != null ? <div className="hint">Source group: {match.sourceGroup ?? '—'} · Source order: {match.sourceOrder == null ? '—' : String(match.sourceOrder)}</div> : null}
    </article>
  );
}

function GroundedSummary({ summary, relevantMatches }) {
  const allowedSources = new Set((relevantMatches || []).map((match) => String(match.sourceId)));
  const evidence = (summary?.evidence || []).filter((item) => allowedSources.has(String(item.sourceId)));
  if (summary?.status !== 'ready' || !evidence.length) return null;
  return (
    <article className="card qa-grounded-summary">
      <div className="qa-answer-head">
        <div>
          <span className="badge">Synthesized answer</span>
          <span className="badge">{evidence.length} excerpt{evidence.length === 1 ? '' : 's'}</span>
          <span className="badge">{new Set(evidence.map((item) => String(item.sourceId))).size} source{new Set(evidence.map((item) => String(item.sourceId))).size === 1 ? '' : 's'}</span>
        </div>
        <span className="mono">meaning-based · grounded</span>
      </div>
      <div className="qa-summary-text">{summary.text}</div>
      <div className="hint qa-summary-note">This answer may paraphrase. It is generated only from passages that independently passed the same “show relevant only” threshold.</div>
      <div className="section-title">Supporting passages</div>
      <ol className="qa-summary-lines">
        {evidence.map((item, index) => (
          <li key={`${item.sourceId}:${item.evidenceNumber ?? index}`} value={item.evidenceNumber ?? index + 1}>
            <div className="qa-summary-text">{item.text}</div>
            <div className="qa-summary-citation">
              <span className="badge">Evidence {item.evidenceNumber ?? index + 1}</span>
              <span className="badge">Source {item.sourceId}</span>
              <span className="badge">Passage meaning {Number(item.semanticSimilarity).toFixed(3)}</span>
              <span className="badge">Record relevance {Number(item.recordRelevance).toFixed(3)}</span>
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

function SearchScreen({ runtime, settings, setSettings, onNavigate }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readyForSearch = connectionConfigured(settings.indexConnection);

  if (!readyForSearch) {
    return <div className="card qa-empty-state"><h3>Index database credentials are required</h3><div className="hint">Configure the index PostgreSQL connection, initialize it, and complete a first sync before searching.</div><div className="toolbar"><button className="btn primary" onClick={() => onNavigate('setup')}>Open setup</button><button className="btn" onClick={() => onNavigate('settings')}>Open Settings</button></div></div>;
  }

  const search = async (event) => {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api(runtime, '/search', {
        body: {
          indexConnection: settings.indexConnection,
          ollamaBaseUrl: settings.ollamaBaseUrl,
          question,
          topK: settings.topK,
          threshold: settings.threshold,
          summary: {
            enabled: settings.summaryEnabled,
            model: settings.summaryModel,
            maxRecords: settings.summaryMaxRecords,
            maxLines: settings.summaryMaxLines,
          },
        },
        timeoutMs: 180000,
      }));
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setBusy(false);
    }
  };

  const acceptedMatch = result?.acceptedMatch || null;
  const summaryEvidenceIds = new Set(
    result?.summary?.status === 'ready'
      ? (result.summary.evidence || []).map((item) => String(item.sourceId))
      : [],
  );
  const remainingMatches = (result?.matches || []).filter((match) => (
    !sameMatch(match, acceptedMatch) &&
    !summaryEvidenceIds.has(String(match.sourceId))
  ));
  const inspectorLabel = acceptedMatch ? 'Related / nearest source records' : 'Nearest source records';
  const summaryCitationValid = result?.summary?.status !== 'ready' || (
    result.summary.evidence?.length > 0 &&
    result.summary.evidence.every((item) =>
      (result.relevantMatches || []).some((match) => String(match.sourceId) === String(item.sourceId)))
  );

  return (
    <div className="qa-stack">
      <form className="card qa-search-card" onSubmit={search}>
        <h3>Ask the indexed corpus</h3>
        <div className="hint">
          Retrieval compares your question with independently indexed answer passages. The summary may paraphrase, but it can use only passages that pass “show relevant only.”
        </div>
        <textarea className="qa-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Enter a question…" />
        <div className="toolbar">
          <button className="btn primary" type="submit" disabled={busy || !question.trim()}>
            {busy ? (settings.summaryEnabled ? 'Pooling evidence…' : 'Searching…') : (settings.summaryEnabled ? 'Search and summarize' : 'Search answers')}
          </button>
          <label className="chip qa-summary-toggle">
            <input
              type="checkbox"
              checked={Boolean(settings.summaryEnabled)}
              onChange={(event) => setSettings((current) => ({ ...current, summaryEnabled: event.target.checked }))}
            />
            Synthesized grounded answer
          </label>
          <span className="badge">Top {settings.topK}</span>
          <span className="badge">Threshold {Number(settings.threshold).toFixed(2)}</span>
          {settings.summaryEnabled ? <span className="badge">Pool up to {settings.summaryMaxRecords}</span> : null}
        </div>
      </form>
      {error ? <div className="alert warn">{error}</div> : null}
      {!acceptedMatch && result?.message ? <div className="alert warn qa-no-match">{result.message}</div> : null}
      {!summaryCitationValid ? (
        <div className="alert warn qa-no-match">The summary was withheld because its evidence citations did not pass relevance validation.</div>
      ) : null}
      {summaryCitationValid ? <GroundedSummary summary={result?.summary} relevantMatches={result?.relevantMatches} /> : null}
      {acceptedMatch && result?.summary?.status === 'unavailable' ? (
        <div className="alert warn qa-no-match">Relevant evidence was found, but its semantic summary could not be prepared. The stored answer remains available below.</div>
      ) : null}
      {acceptedMatch ? (
        <div className="qa-results">
          <MatchRecord match={acceptedMatch} label={result?.summary?.status === 'ready' ? 'Primary stored source' : 'Best answer'} />
        </div>
      ) : null}
      {remainingMatches.length ? (
        <details className="card" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 800 }}>
            {inspectorLabel} ({remainingMatches.length}) — inspection only
          </summary>
          <div className="hint" style={{ margin: '10px 0 14px' }}>
            These are retrieval neighbors, not accepted answers and not summary evidence. Open them only to inspect why the search ranked nearby source records.
          </div>
          <div className="qa-results">
            {remainingMatches.map((match, index) => (
              <MatchRecord
                match={match}
                label={acceptedMatch ? 'Related / nearest source' : 'Nearest source'}
                key={`${match.sourceId ?? 'match'}:${match.relevanceRank ?? index}`}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function IndexScreen({ runtime, settings }) {
  const [status, setStatus] = useState(null);
  const [job, setJob] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const eventSource = useRef(null);
  const indexConfigured = connectionConfigured(settings.indexConnection);
  const syncConfigured = indexConfigured && connectionConfigured(settings.sourceConnection) && mappingConfigured(settings.mapping);

  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await api(runtime, '/index/status', { body: { indexConnection: settings.indexConnection } }));
    } catch (error) {
      setMessage({ kind: 'error', message: error.message });
    } finally { setBusy(false); }
  };

  useEffect(() => () => eventSource.current?.close(), []);

  const initialize = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api(runtime, '/index/initialize', { body: {
        indexConnection: settings.indexConnection,
        ollamaBaseUrl: settings.ollamaBaseUrl,
        model: settings.model,
      }, timeoutMs: 180000 });
      setMessage({
        kind: response.requiresRebuild ? 'error' : 'success',
        message: response.requiresRebuild
          ? 'The existing index is incompatible with the current model or retrieval format. Run a full rebuild.'
          : `Index initialized for ${response.model.model} (${response.model.dimension} dimensions).`,
      });
      await refresh();
    } catch (error) { setMessage({ kind: 'error', message: error.message }); }
    finally { setBusy(false); }
  };

  const followJob = (jobId) => {
    eventSource.current?.close();
    const source = new EventSource(authQuery(joinPath(runtime.apiBasePath, `/sync/${encodeURIComponent(jobId)}/events`)));
    eventSource.current = source;
    const update = (event) => {
      try {
        const next = JSON.parse(event.data);
        setJob(next);
        if (['completed', 'failed', 'cancelled'].includes(next.status)) {
          source.close();
          void refresh();
        }
      } catch { /* ignore malformed event */ }
    };
    ['status', 'progress', 'log'].forEach((name) => source.addEventListener(name, update));
  };

  const startSync = async (mode) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api(runtime, '/sync', { body: {
        sourceConnection: settings.sourceConnection,
        indexConnection: settings.indexConnection,
        mapping: settings.mapping,
        ollamaBaseUrl: settings.ollamaBaseUrl,
        model: settings.model,
        mode,
        fetchSize: settings.fetchSize,
        embeddingBatchSize: settings.embeddingBatchSize,
      } });
      setJob(response.job);
      followJob(response.job.id);
    } catch (error) { setMessage({ kind: 'error', message: error.message }); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!job?.id) return;
    try { setJob((await api(runtime, `/sync/${job.id}/cancel`, { body: {} })).job); }
    catch (error) { setMessage({ kind: 'error', message: error.message }); }
  };

  return (
    <div className="qa-stack">
      <div className="card">
        <div className="qa-card-title"><div><h3>Vector index</h3><div className="hint">The previous live index remains available until a sync commits successfully.</div></div><button className="btn" disabled={busy} onClick={refresh}>Refresh status</button></div>
        <StatusMessage status={message} />
        {!indexConfigured ? <div className="alert warn">Configure the index PostgreSQL credentials in Settings before initializing.</div> : null}
        {indexConfigured && !syncConfigured ? <div className="alert warn">Initialization is available, but synchronization also needs source credentials and a complete corpus mapping.</div> : null}
        {status?.requiresRebuild ? <div className="alert warn">This index cannot be searched safely until a full rebuild completes. {(status.rebuildReasons || []).join('; ')}.</div> : null}
        <div className="qa-stat-grid">
          <div><span>State</span><strong>{status ? (status.requiresRebuild ? 'Rebuild required' : status.initialized ? 'Ready' : 'Not initialized') : 'Unknown'}</strong></div>
          <div><span>Records</span><strong>{status?.recordCount ?? '—'}</strong></div>
          <div><span>Answer passages</span><strong>{status?.passageCount ?? '—'}</strong></div>
          <div><span>Model</span><strong>{status?.corpus?.embeddingModel || '—'}</strong></div>
          <div><span>Dimensions</span><strong>{status?.corpus?.embeddingDimension || '—'}</strong></div>
          <div><span>Last sync</span><strong>{status?.corpus?.lastSyncedAt ? new Date(status.corpus.lastSyncedAt).toLocaleString() : '—'}</strong></div>
        </div>
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn" onClick={initialize} disabled={!indexConfigured || busy || ['queued', 'running'].includes(job?.status)}>Initialize</button>
          <button className="btn primary" onClick={() => startSync('incremental')} disabled={!syncConfigured || status?.requiresRebuild || busy || ['queued', 'running'].includes(job?.status)}>Incremental sync</button>
          <button className="btn danger" onClick={() => startSync('rebuild')} disabled={!syncConfigured || busy || ['queued', 'running'].includes(job?.status)}>Full rebuild</button>
          {['queued', 'running'].includes(job?.status) ? <button className="btn" onClick={cancel}>Cancel</button> : null}
        </div>
      </div>
      {job ? <div className="card">
        <div className="qa-card-title"><h3>Sync {job.id}</h3><span className="badge">{job.status}</span></div>
        <div className="qa-progress"><span style={{ width: `${job.percent || 0}%` }} /></div>
        <div className="hint">{job.processed} / {job.total} scanned · {job.changed} records changed · {job.passages || 0} answer passages embedded · {job.percent || 0}%</div>
        {job.error ? <div className="alert warn" style={{ marginTop: 12 }}>{job.error}</div> : null}
        <pre className="qa-log">{(job.logs || []).join('\n')}</pre>
      </div> : null}
      {status?.recentRuns?.length ? <div className="card"><h3>Recent runs</h3><div className="qa-run-list">{status.recentRuns.map((run) => <div key={run.id}><span className="mono">{run.id}</span><span>{run.mode}</span><span className="badge">{run.status}</span><span>{run.changed} changed</span></div>)}</div></div> : null}
    </div>
  );
}

function SettingsScreen({ runtime, settings, setSettings, catalog, setCatalog }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const selectedSchema = catalog.find((schema) => schema.name === settings.mapping.schema);
  const selectedTable = selectedSchema?.tables.find((table) => table.name === settings.mapping.table);
  const columns = selectedTable?.columns || [];

  const updateConnection = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const updateMapping = (patch) => setSettings((current) => ({ ...current, mapping: { ...current.mapping, ...patch } }));

  const call = async (path, body, success) => {
    setBusy(true); setStatus(null);
    try {
      const response = await api(runtime, path, { body, timeoutMs: 180000 });
      setStatus({ kind: 'success', message: success(response) });
      return response;
    } catch (error) { setStatus({ kind: 'error', message: error.message }); return null; }
    finally { setBusy(false); }
  };

  const discover = async () => {
    const response = await call('/source/catalog', { connection: settings.sourceConnection }, () => 'Source connected; catalog loaded.');
    if (!response) return;
    setCatalog(response.schemas || []);
    const schema = response.schemas?.find((item) => item.name === settings.mapping.schema) || response.schemas?.[0];
    const table = schema?.tables.find((item) => item.name === settings.mapping.table) || schema?.tables?.[0];
    if (schema && table) {
      const primary = table.columns.find((column) => column.primaryKey)?.name || '';
      const question = table.columns.find((column) => /question|query/i.test(column.name))?.name || '';
      const answer = table.columns.find((column) => /answer|response/i.test(column.name))?.name || '';
      updateMapping({ schema: schema.name, table: table.name, idColumn: primary, questionColumn: question, answerColumn: answer, metadataColumns: [] });
    }
  };

  const chooseSchema = (name) => {
    const schema = catalog.find((item) => item.name === name);
    const table = schema?.tables?.[0];
    updateMapping({ schema: name, table: table?.name || '', idColumn: '', questionColumn: '', answerColumn: '', metadataColumns: [], groupColumn: '', orderColumn: '' });
  };
  const chooseTable = (name) => {
    const table = selectedSchema?.tables.find((item) => item.name === name);
    updateMapping({ table: name, idColumn: table?.columns.find((column) => column.primaryKey)?.name || '', questionColumn: '', answerColumn: '', metadataColumns: [], groupColumn: '', orderColumn: '' });
  };

  return (
    <div className="qa-stack">
      <StatusMessage status={status} />
      <div className="card qa-stack">
        <ConnectionFields label="Source PostgreSQL (read only)" value={settings.sourceConnection} onChange={(value) => updateConnection('sourceConnection', value)} />
        <div className="toolbar"><button className="btn primary" disabled={busy} onClick={discover}>Test and discover catalog</button></div>
      </div>
      <div className="card qa-stack">
        <ConnectionFields label="Separate pgvector PostgreSQL" value={settings.indexConnection} onChange={(value) => updateConnection('indexConnection', value)} />
        <div className="toolbar"><button className="btn" disabled={busy} onClick={() => call('/index/test', { connection: settings.indexConnection }, (response) => `Index database connected${response.connection.vectorVersion ? `; pgvector ${response.connection.vectorVersion}` : '; pgvector is not installed yet'}.`)}>Test index database</button></div>
      </div>
      <div className="card">
        <h3>Ollama models</h3>
        <div className="form-grid">
          <label className="field"><span className="field-label">Base URL</span><input value={settings.ollamaBaseUrl} onChange={(event) => setSettings((current) => ({ ...current, ollamaBaseUrl: event.target.value }))} /></label>
          <label className="field"><span className="field-label">Embedding model</span><input value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} /></label>
          <label className="field"><span className="field-label">Summary model</span><input value={settings.summaryModel} onChange={(event) => setSettings((current) => ({ ...current, summaryModel: event.target.value }))} /></label>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={() => call('/ollama/test', { ollamaBaseUrl: settings.ollamaBaseUrl, model: settings.model }, (response) => `Ollama connected; ${response.model} returns ${response.dimension} dimensions.`)}>Test Ollama</button>
      </div>
      <div className="card">
        <h3>Corpus mapping</h3>
        {!catalog.length ? <div className="hint">Connect to the source database to choose fields from its catalog.</div> : <>
          <div className="form-grid">
            <label className="field"><span className="field-label">Schema</span><select value={settings.mapping.schema} onChange={(event) => chooseSchema(event.target.value)}>{catalog.map((schema) => <option key={schema.name}>{schema.name}</option>)}</select></label>
            <label className="field"><span className="field-label">Table</span><select value={settings.mapping.table} onChange={(event) => chooseTable(event.target.value)}>{selectedSchema?.tables.map((table) => <option key={table.name}>{table.name}</option>)}</select></label>
            {[['idColumn', 'Unique ID'], ['questionColumn', 'Question'], ['answerColumn', 'Answer']].map(([key, label]) => <label className="field" key={key}><span className="field-label">{label}</span><select value={settings.mapping[key] || ''} onChange={(event) => updateMapping({ [key]: event.target.value })}><option value="">Select…</option>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}{column.primaryKey ? ' (PK)' : ''}</option>)}</select></label>)}
            <label className="field">
              <span className="field-label">Document ID for chunk grouping (optional)</span>
              <select value={settings.mapping.groupColumn || ''} onChange={(event) => updateMapping({ groupColumn: event.target.value })}><option value="">Select…</option>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}{column.primaryKey ? ' (PK)' : ''}</option>)}</select>
              <span className="hint">Use only when several rows are chunks of one document. All chunks of that document must share this value; do not use a category or topic.</span>
            </label>
            <label className="field">
              <span className="field-label">Chunk order within document (optional)</span>
              <select value={settings.mapping.orderColumn || ''} onChange={(event) => updateMapping({ orderColumn: event.target.value })}><option value="">Select…</option>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}{column.primaryKey ? ' (PK)' : ''}</option>)}</select>
              <span className="hint">Use with document grouping to preserve the order of chunks from the same document.</span>
            </label>
          </div>
          <div className="section-title" style={{ marginTop: 14 }}>Metadata columns</div>
          <div className="chip-list" style={{ marginTop: 8 }}>{columns.filter((column) => ![settings.mapping.idColumn, settings.mapping.questionColumn, settings.mapping.answerColumn].includes(column.name)).map((column) => <label className="chip" key={column.name}><input type="checkbox" checked={settings.mapping.metadataColumns.includes(column.name)} onChange={(event) => updateMapping({ metadataColumns: event.target.checked ? [...settings.mapping.metadataColumns, column.name] : settings.mapping.metadataColumns.filter((name) => name !== column.name) })} />{column.name}</label>)}</div>
        </>}
      </div>
      <div className="card">
        <h3>Retrieval and sync defaults</h3>
        <div className="form-grid">
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Result count</span><input type="number" min="1" max="20" value={settings.topK} onChange={(event) => setSettings((current) => ({ ...current, topK: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Clear-match threshold</span><input type="number" min="-1" max="1" step="0.01" value={settings.threshold} onChange={(event) => setSettings((current) => ({ ...current, threshold: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Summary source pool</span><input type="number" min="1" max="15" value={settings.summaryMaxRecords} onChange={(event) => setSettings((current) => ({ ...current, summaryMaxRecords: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Maximum summary sentences</span><input type="number" min="1" max="5" value={settings.summaryMaxLines} onChange={(event) => setSettings((current) => ({ ...current, summaryMaxLines: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Source page size</span><input type="number" min="25" max="1000" value={settings.fetchSize} onChange={(event) => setSettings((current) => ({ ...current, fetchSize: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Embedding batch size</span><input type="number" min="1" max="64" value={settings.embeddingBatchSize} onChange={(event) => setSettings((current) => ({ ...current, embeddingBatchSize: Number(event.target.value) }))} /></label>
        </div>
        <label className="chip qa-summary-toggle" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={Boolean(settings.summaryEnabled)} onChange={(event) => setSettings((current) => ({ ...current, summaryEnabled: event.target.checked }))} />
          Enable grounded semantic summaries by default
        </label>
        <div className="hint" style={{ marginTop: 10 }}>The summary model may paraphrase and combine evidence from several records. It receives only answer passages whose passage-level relevance independently passes the clear-match threshold.</div>
        <div className="hint" style={{ marginTop: 12 }}>Non-secret settings save automatically. Passwords and connection strings are never persisted.</div>
      </div>
    </div>
  );
}

export default function SemanticQaTool({ runtime: providedRuntime }) {
  const runtime = { ...STANDALONE_RUNTIME, ...(providedRuntime || {}) };
  const storageKey = `${runtime.storagePrefix}.settings`;
  const [tab, setTab] = useState('setup');
  const [settings, setSettings] = useState(() => {
    try { return mergeSettings(JSON.parse(localStorage.getItem(storageKey) || '{}')); }
    catch { return { ...DEFAULT_SETTINGS }; }
  });
  const [catalog, setCatalog] = useState([]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(stripSecrets(settings))); }
    catch { /* localStorage can be unavailable */ }
  }, [settings, storageKey]);

  const screen = useMemo(() => {
    if (tab === 'setup') return <SetupScreen runtime={runtime} settings={settings} onNavigate={setTab} onLoadDemo={() => setSettings(mergeSettings(LOCAL_DEMO_SETTINGS))} onLoadUniversal={() => setSettings(mergeSettings(UNIVERSAL_QA_SETTINGS))} />;
    if (tab === 'index') return <IndexScreen runtime={runtime} settings={settings} />;
    if (tab === 'settings') return <SettingsScreen runtime={runtime} settings={settings} setSettings={setSettings} catalog={catalog} setCatalog={setCatalog} />;
    return <SearchScreen runtime={runtime} settings={settings} setSettings={setSettings} onNavigate={setTab} />;
  }, [tab, runtime.apiBasePath, settings, catalog]);

  return (
    <div className="semantic-qa">
      <div className="panel">
        <div className="panel-header">
          <div><h3 style={{ margin: 0 }}>Semantic Q&A retrieval</h3><div className="hint" style={{ marginTop: 5 }}>Meaning-first retrieval with grounded, verbatim evidence summaries.</div></div>
          <div className="tabs" role="tablist">{[['setup', 'Setup'], ['search', 'Search'], ['index', 'Index'], ['settings', 'Settings']].map(([id, label]) => <button key={id} className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
        </div>
        <div className="panel-body">{screen}</div>
      </div>
    </div>
  );
}

export { STANDALONE_RUNTIME };
