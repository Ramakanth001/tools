import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_SETTINGS, LOCAL_DEMO_SETTINGS, UNIVERSAL_QA_SETTINGS, mergeSettings, reconcileCatalogMapping, stripSecrets } from './settings.mjs';
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
          deepSummaryModel: settings.deepSummaryModel,
          hardwarePreference: settings.summaryHardwarePreference,
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
          <DiagnosticRow label="Deep Search Qwen" check={report?.checks?.summaryModel} pendingText="Required only for Deep Search" />
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
        <div className="card"><span className="qa-step-number">1</span><h3>Install and start Ollama</h3><pre className="qa-command">brew install ollama{`\n`}brew services start ollama{`\n`}ollama pull {settings.model}{`\n`}ollama pull {settings.deepSummaryModel}</pre><div className="hint">The embedding model finds teachings. Deep Search uses a reasoning-capable Qwen model only to select and classify exact source text.</div></div>
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

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function downloadText(filename, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function HighlightedDocument({ text, highlights }) {
  const safe = (highlights || []).filter((item) => item.start >= 0 && item.end > item.start && item.end <= text.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const parts = [];
  let cursor = 0;
  safe.forEach((highlight, index) => {
    if (highlight.start < cursor) return;
    parts.push(text.slice(cursor, highlight.start));
    parts.push(<mark id={`evidence-highlight-${index}`} key={`${highlight.start}:${highlight.end}`} title={highlight.label}>{text.slice(highlight.start, highlight.end)}</mark>);
    cursor = highlight.end;
  });
  parts.push(text.slice(cursor));
  return <div className="qa-full-document">{parts}</div>;
}

function DocumentViewer({ runtime, indexConnection, request, onClose }) {
  const [documentResult, setDocumentResult] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!request) return undefined;
    let active = true;
    setDocumentResult(null); setError('');
    api(runtime, '/documents/get', { body: { indexConnection, reference: request.reference, highlights: request.highlights || [] }, timeoutMs: 60000 })
      .then((value) => { if (active) setDocumentResult(value.document); })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [request, runtime.apiBasePath, indexConnection]);
  useEffect(() => {
    if (!documentResult?.highlights?.length) return;
    requestAnimationFrame(() => document.getElementById('evidence-highlight-0')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [documentResult]);
  useEffect(() => {
    if (!request) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [request, onClose]);
  if (!request) return null;
  return createPortal(
    <div className="semantic-qa qa-document-portal">
      <div className="qa-modal-backdrop">
        <section className="qa-document-viewer" role="dialog" aria-modal="true" aria-label="Full discourse reader">
          <header className="qa-document-header">
            <div className="qa-document-heading"><span className="badge">Full discourse</span><h2>{documentResult?.title || request.title || 'Loading source…'}</h2></div>
            <button className="btn" type="button" onClick={onClose}>Back to discourses</button>
          </header>
          <div className="qa-document-body">
            {error ? <div className="alert warn">{error}</div> : null}
            {!documentResult && !error ? <div className="hint qa-document-loading">Reconstructing all available discourse chunks…</div> : null}
            {documentResult ? <>
              <div className="toolbar qa-document-meta">
                <span className="badge">{documentResult.sourceGroup}</span>
                <span className="badge">{documentResult.chunks.length} chunk{documentResult.chunks.length === 1 ? '' : 's'}</span>
                <span className="badge">{documentResult.highlights.length} highlighted passage{documentResult.highlights.length === 1 ? '' : 's'}</span>
              </div>
              <HighlightedDocument text={documentResult.text} highlights={documentResult.highlights} />
            </> : null}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function evidenceSourceTitle(item) {
  return String(item?.sourceTitle || item?.question || '').trim() || `Source ${item?.sourceId || 'unknown'}`;
}

function evidenceTitleLabel(item) {
  const sourceReference = String(item?.sourceGroup || item?.sourceId || '');
  return sourceReference.startsWith('discourse:') ? 'Discourse title' : 'Source title';
}

function deepSummaryMarkdown(question, searchMode, result) {
  const lines = [`# ${result.title || 'Deep Search'}`, '', `**Question:** ${question}`, `**Outcome:** ${result.answerStatus}`, '', result.notice || '', ''];
  for (const paragraph of result.paragraphs || []) lines.push(paragraph.text, '');
  lines.push('## Audit', '');
  Object.entries(result.audit || {}).forEach(([key, value]) => lines.push(`- ${key}: ${value}`));
  lines.push('', '## Evidence', '');
  (result.evidence || []).forEach((item) => lines.push(
    `### [${item.evidenceNumber}] ${evidenceSourceTitle(item)}`,
    '',
    `**Source:** ${item.sourceId}`,
    '',
    item.text,
    '',
  ));
  return `${lines.join('\n')}\n`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

function phaseStatusText(status) {
  return ({ completed: 'Done', running: 'In progress', pending: 'Yet to start', skipped: 'Skipped', failed: 'Failed', cancelled: 'Cancelled' })[status] || status;
}

function DeepSummaryProgress({ job, collapsible = false }) {
  const phases = Array.isArray(job?.phases) ? job.phases : [];
  if (!phases.length) return null;
  const overallPercent = Number(job.overallPercent ?? job.percent) || 0;
  const eta = job.status === 'completed'
    ? `Completed in ${formatDuration(job.elapsedSeconds)}`
    : `${job.currentOperation || 'Working'} · elapsed ${formatDuration(job.elapsedSeconds)}`;
  const content = <>
    <div className="qa-overall-progress"><div className="qa-phase-title"><strong>Overall progress</strong><span>{overallPercent}%</span></div><div className="qa-progress"><span style={{ width: `${overallPercent}%` }} /></div><div className="hint">{eta}</div></div>
    <div className="qa-runtime-device"><span className="badge">Device choice: {({ auto: 'Auto', gpu: 'Prefer GPU', cpu: 'CPU only' })[job.hardwarePreference] || 'Auto'}</span><span className="badge">Actual processor: {job.hardware?.runtime?.processor || 'checking after first Ollama batch…'}</span></div>
    <ol className="qa-phase-list">
      {phases.map((phase, index) => <li className={`qa-phase-step ${phase.status}`} key={phase.id}>
        <span className="qa-phase-marker" aria-hidden="true">{phase.status === 'completed' ? '✓' : index + 1}</span>
        <div className="qa-phase-content">
          <div className="qa-phase-title"><strong>Phase {index + 1}: {phase.name}</strong><span>{phaseStatusText(phase.status)}</span></div>
          {phase.status === 'running' ? <><div className="qa-progress"><span style={{ width: `${phase.percent || 0}%` }} /></div><div className="hint">{phase.processed || 0} / {phase.total || '—'} {phase.unit} · {phase.percent || 0}% · elapsed {formatDuration(phase.elapsedSeconds)}{phase.etaSeconds != null ? ` · phase ETA ${formatDuration(phase.etaSeconds)} · projected phase total ${formatDuration(phase.estimatedDurationSeconds)}` : ''}{job.parallelism > 1 ? ` · limit ${job.parallelism} in-flight Ollama requests` : ''}{job.activeRequests ? ` · ${job.activeRequests} in flight` : ''}</div></> : null}
          {phase.status === 'pending' && phase.estimatedDurationSeconds != null ? <div className="hint">Estimated phase duration: {formatDuration(phase.estimatedDurationSeconds)}</div> : null}
          {phase.status === 'completed' && phase.elapsedSeconds != null ? <div className="hint">Finished in {formatDuration(phase.elapsedSeconds)}</div> : null}
        </div>
      </li>)}
    </ol>
  </>;
  return collapsible ? <details className="qa-phase-tracker completed"><summary>{eta}</summary>{content}</details> : <div className="qa-phase-tracker">{content}</div>;
}

function DeepSummary({ question, searchMode, job, onOpenDocument, onCancel }) {
  const result = job?.result;
  if (!job) return null;
  if (job.status !== 'completed' || result?.status !== 'ready') {
    return <div className="card qa-deep-summary"><div className="qa-card-title"><h3>Deep Search</h3><div className="toolbar"><span className="badge">{job.currentOperation || job.phase || job.status}</span>{['queued', 'running'].includes(job.status) ? <button className="btn" type="button" onClick={onCancel}>Cancel</button> : null}</div></div><DeepSummaryProgress job={job} />{job.error ? <div className="alert warn">{job.error}</div> : null}{job.status === 'completed' && result?.status !== 'ready' ? <div className="alert warn">{result?.notice || 'No responsibly relevant Swami teaching was found.'}</div> : null}</div>;
  }
  const markdown = deepSummaryMarkdown(question, searchMode, result);
  const printReport = () => {
    const popup = window.open('', '_blank');
    if (!popup) return;
    popup.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(result.title)}</title><style>body{font:16px/1.7 system-ui;max-width:900px;margin:40px auto;padding:0 24px}h1,h2{line-height:1.25}.source{color:#555;margin-top:-12px}blockquote{border-left:3px solid #999;padding-left:16px;white-space:pre-wrap}@media print{button{display:none}}</style><h1>${escapeHtml(result.title)}</h1><p><strong>Question:</strong> ${escapeHtml(question)}</p>${result.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p>`).join('')}<h2>Evidence</h2>${result.evidence.map((item) => `<h3>[${item.evidenceNumber}] ${escapeHtml(evidenceSourceTitle(item))}</h3><p class="source">Source ${escapeHtml(item.sourceId)}</p><blockquote>${escapeHtml(item.text)}</blockquote>`).join('')}<script>window.onload=()=>window.print()<\/script>`);
    popup.document.close();
  };
  return (
    <article className="card qa-deep-summary">
      <div className="qa-card-title"><div><span className="badge">Verified Deep Search · {result.answerStatus}</span><h2>{result.title}</h2></div><div className="toolbar"><button className="btn" onClick={() => downloadText(`search-engine-deep-search-${new Date().toISOString().slice(0, 10)}.md`, markdown)}>Download Markdown</button><button className="btn" onClick={printReport}>Print / Save PDF</button></div></div>
      <DeepSummaryProgress job={job} collapsible />
      <div className="alert">{result.notice}</div>
      <div className="qa-coverage-grid">
        <span><strong>{result.audit?.probes ?? '—'}</strong> probes</span><span><strong>{result.audit?.sourcesRead ?? '—'}</strong> sources read</span><span><strong>{result.audit?.rejectedEvidence ?? '—'}</strong> discarded</span><span><strong>{result.audit?.finalVerification ?? '—'}</strong> verified</span>
      </div>
      <div className="qa-deep-article">{(result.paragraphs || []).map((paragraph, index) => <p key={index}>{paragraph.text}</p>)}</div>
      <details className="qa-deep-evidence"><summary>Evidence ({result.evidence.length})</summary><ol className="qa-summary-lines">{result.evidence.map((item) => <li key={item.evidenceNumber}>
        <div className="qa-evidence-heading">
          <div><span className="qa-evidence-title-label">{evidenceTitleLabel(item)}</span><button className="qa-evidence-title" type="button" onClick={() => onOpenDocument({ reference: item.sourceGroup || item.sourceId, title: evidenceSourceTitle(item), highlights: [{ sourceId: item.sourceId, start: item.start, end: item.end, evidenceNumber: item.evidenceNumber, label: `Evidence ${item.evidenceNumber}` }] })}>[{item.evidenceNumber}] {evidenceSourceTitle(item)}</button></div>
          <span className="hint">Source {item.sourceId}</span>
        </div>
        <div className="qa-summary-text">{item.text}</div>
      </li>)}</ol></details>
    </article>
  );
}

function MatchRecord({ match, label, searchMode = 'semantic', onOpenDocument }) {
  const bestPassage = match.matchedPassages?.[0];
  const open = () => onOpenDocument?.({
    reference: match.sourceId,
    title: match.question,
    highlights: bestPassage ? [{ sourceId: match.sourceId, start: bestPassage.start, end: bestPassage.end, label: 'Best matching passage' }] : [],
  });
  return (
    <article className="card qa-answer">
      <div className="qa-answer-head">
        <div>
          <span className="badge">{label}</span>
          {match.relevanceRank != null ? <span className="badge">#{match.relevanceRank}</span> : null}
          <span className="badge">Relevance {Number(match.relevanceScore ?? match.similarity).toFixed(3)}</span>
          {searchMode === 'semantic' && match.relevanceScore != null ? <span className="badge">Cosine {Number(match.similarity).toFixed(3)}</span> : null}
          {searchMode === 'search' && match.matchChannels?.length ? <span className="badge">{match.matchChannels.join(' · ')}</span> : null}
        </div>
        <button className="btn qa-source-link" type="button" onClick={open}>Source {match.sourceId}</button>
      </div>
      <button className="qa-stored-question qa-title-button" type="button" onClick={open}>{match.question}</button>
      {bestPassage ? (
        <div className="qa-matched-passage">
          <div className="section-title">Best matching answer passage</div>
          <div className="qa-summary-text">{bestPassage.text}</div>
          <div className="hint">{searchMode === 'search' ? `Search score ${Number(bestPassage.searchScore || match.searchScore).toFixed(3)} · ${bestPassage.matchChannels?.join(', ') || 'text match'}` : `Passage meaning ${Number(bestPassage.semanticSimilarity).toFixed(3)} · stored title/question had zero ranking weight`}</div>
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

function GroundedSummary({ summary, relevantMatches, onOpenDocument, searchMode = 'semantic' }) {
  const allowedSources = new Set((relevantMatches || []).map((match) => String(match.sourceId)));
  const evidence = (summary?.evidence || []).filter((item) => allowedSources.has(String(item.sourceId)));
  if (summary?.status !== 'ready' || !evidence.length) return null;
  return (
    <article className="card qa-grounded-summary">
      <div className="qa-answer-head">
        <div>
          <span className="badge">Verbatim teaching selection</span>
          <span className="badge">{evidence.length} excerpt{evidence.length === 1 ? '' : 's'}</span>
          <span className="badge">{new Set(evidence.map((item) => String(item.sourceId))).size} source{new Set(evidence.map((item) => String(item.sourceId))).size === 1 ? '' : 's'}</span>
        </div>
        <span className="mono">{searchMode === 'search' ? 'text-ranked' : 'meaning-based'} · grounded</span>
      </div>
      <div className="qa-summary-text">{summary.text}</div>
      <div className="hint qa-summary-note">Every teaching above is exact stored Swami text. Only the neutral status label is generated by the interface.</div>
      <div className="section-title">Supporting passages</div>
      <ol className="qa-summary-lines">
        {evidence.map((item, index) => (
          <li key={`${item.sourceId}:${item.evidenceNumber ?? index}`} value={item.evidenceNumber ?? index + 1}>
            <div className="qa-summary-text">{item.text}</div>
            <div className="qa-summary-citation">
              <span className="badge">Evidence {item.evidenceNumber ?? index + 1}</span>
              <button className="badge qa-source-button" type="button" onClick={() => onOpenDocument?.({ reference: item.sourceId, title: item.question, highlights: [{ sourceId: item.sourceId, start: item.start, end: item.end, evidenceNumber: item.evidenceNumber, label: `Evidence ${item.evidenceNumber}` }] })}>Source {item.sourceId}</button>
              <span className="badge">{searchMode === 'search' ? 'Passage search' : 'Passage meaning'} {Number(item.semanticSimilarity).toFixed(3)}</span>
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
  const [deepJob, setDeepJob] = useState(null);
  const [viewerRequest, setViewerRequest] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const deepEvents = useRef(null);
  const readyForSearch = connectionConfigured(settings.indexConnection);

  useEffect(() => () => deepEvents.current?.close(), []);

  if (!readyForSearch) {
    return <div className="card qa-empty-state"><h3>Index database credentials are required</h3><div className="hint">Configure the index PostgreSQL connection, initialize it, and complete a first sync before searching.</div><div className="toolbar"><button className="btn primary" onClick={() => onNavigate('setup')}>Open setup</button><button className="btn" onClick={() => onNavigate('settings')}>Open Settings</button></div></div>;
  }

  const followDeepJob = (jobId) => {
    deepEvents.current?.close();
    const source = new EventSource(authQuery(joinPath(runtime.apiBasePath, `/deep-summary/${encodeURIComponent(jobId)}/events`)));
    deepEvents.current = source;
    const update = (event) => {
      try {
        const next = JSON.parse(event.data);
        setDeepJob(next);
        if (['completed', 'failed', 'cancelled'].includes(next.status)) source.close();
      } catch { /* ignore malformed progress */ }
    };
    ['status', 'progress', 'log'].forEach((name) => source.addEventListener(name, update));
  };

  const search = async (event) => {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError('');
    setResult(null);
    setDeepJob(null);
    deepEvents.current?.close();
    try {
      const response = await api(runtime, '/search', {
        body: {
          indexConnection: settings.indexConnection,
          ollamaBaseUrl: settings.ollamaBaseUrl,
          question,
          searchMode: settings.searchMode,
          topK: settings.topK,
          threshold: settings.threshold,
          summary: {
            enabled: settings.summaryMode === 'standard',
            mode: settings.summaryMode,
            model: settings.summaryModel,
            deepModel: settings.deepSummaryModel,
            deliberation: settings.deepSummaryDeliberation,
            maxRecords: settings.summaryMaxRecords,
            maxLines: settings.summaryMaxLines,
            deepMaxRecords: settings.deepSummaryMaxRecords,
            parallelRequests: settings.deepSummaryParallelRequests,
            requestTimeoutMs: settings.deepSummaryTimeoutSeconds * 1000,
            hardwarePreference: settings.summaryHardwarePreference,
          },
        },
        timeoutMs: 180000,
      });
      setResult(response);
      if (response.deepSummaryJob?.id) {
        setDeepJob(response.deepSummaryJob);
        followDeepJob(response.deepSummaryJob.id);
      }
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelDeepSummary = async () => {
    if (!deepJob?.id) return;
    try {
      const response = await api(runtime, `/deep-summary/${encodeURIComponent(deepJob.id)}/cancel`, { body: {} });
      setDeepJob(response.job);
    } catch (cancelError) { setError(cancelError.message); }
  };

  const acceptedMatch = result?.acceptedMatch || null;
  const deepReady = deepJob?.status === 'completed' && deepJob?.result?.status === 'ready';
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
        <div className="qa-card-title"><div><h3>{settings.searchMode === 'semantic' ? 'Semantic Search' : 'Search'}</h3><div className="hint">{settings.searchMode === 'semantic' ? 'Meaning-first retrieval over independently indexed answer passages.' : 'Exact phrase, PostgreSQL full-text, and trigram-distance ranking fused together.'}</div></div><div className="qa-mode-toggle" role="group" aria-label="Search mode"><button type="button" className={`btn ${settings.searchMode === 'semantic' ? 'primary' : ''}`} onClick={() => setSettings((current) => ({ ...current, searchMode: 'semantic' }))}>Semantic Search</button><button type="button" className={`btn ${settings.searchMode === 'search' ? 'primary' : ''}`} onClick={() => setSettings((current) => ({ ...current, searchMode: 'search' }))}>Search</button></div></div>
        <div className="hint">
          Verbatim Selection returns exact Swami passages quickly. Deep Search reads complete answers and independently adjudicates related teachings.
        </div>
        <textarea className="qa-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Enter a question…" />
        <div className="toolbar">
          <button className="btn primary" type="submit" disabled={busy || !question.trim()}>
            {busy ? 'Searching…' : settings.summaryMode === 'deep' ? 'Run Deep Search' : settings.summaryMode === 'standard' ? 'Select verbatim teachings' : 'Search'}
          </button>
          <label className="field qa-summary-select"><span className="field-label">Answer mode</span><select value={settings.summaryMode} onChange={(event) => setSettings((current) => ({ ...current, summaryMode: event.target.value, summaryEnabled: event.target.value === 'standard' }))}><option value="off">No Summary</option><option value="standard">Verbatim Selection</option><option value="deep">Deep Search</option></select></label>
          {settings.summaryMode === 'deep' ? <label className="field qa-summary-select qa-device-choice"><span className="field-label">Deep Search processor</span><select value={settings.summaryHardwarePreference} onChange={(event) => setSettings((current) => ({ ...current, summaryHardwarePreference: event.target.value }))}><option value="auto">Auto (recommended)</option><option value="gpu">Prefer GPU</option><option value="cpu">CPU only</option></select></label> : null}
          <span className="badge">Top {settings.topK}</span>
          <span className="badge">{settings.searchMode === 'semantic' ? `Threshold ${Number(settings.threshold).toFixed(2)}` : 'Exact + full-text + fuzzy RRF'}</span>
          {settings.summaryMode === 'standard' ? <span className="badge">Pool up to {settings.summaryMaxRecords}</span> : null}
          {settings.summaryMode === 'deep' ? <span className="badge">{settings.searchMode === 'semantic' ? `Score corpus · process top ${settings.deepSummaryMaxRecords}` : `Verify up to ${settings.deepSummaryMaxRecords} text matches`}</span> : null}
        </div>
      </form>
      {error ? <div className="alert warn">{error}</div> : null}
      {!acceptedMatch && result?.message && !deepReady ? <div className="alert warn qa-no-match">{result.message}</div> : null}
      {!summaryCitationValid ? (
        <div className="alert warn qa-no-match">The summary was withheld because its evidence citations did not pass relevance validation.</div>
      ) : null}
      {summaryCitationValid ? <GroundedSummary summary={result?.summary} relevantMatches={result?.relevantMatches} searchMode={result?.searchMode || settings.searchMode} onOpenDocument={setViewerRequest} /> : null}
      <DeepSummary question={question} searchMode={result?.searchMode || settings.searchMode} job={deepJob} onOpenDocument={setViewerRequest} onCancel={cancelDeepSummary} />
      {acceptedMatch && result?.summary?.status === 'unavailable' ? (
        <div className="alert warn qa-no-match">Relevant evidence was found, but its semantic summary could not be prepared. The stored answer remains available below.</div>
      ) : null}
      {acceptedMatch ? (
        <div className="qa-results">
          <MatchRecord match={acceptedMatch} searchMode={result?.searchMode || settings.searchMode} onOpenDocument={setViewerRequest} label={result?.summary?.status === 'ready' ? 'Primary stored source' : 'Best answer'} />
        </div>
      ) : null}
      {remainingMatches.length ? (
        <details className="card" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 800 }}>
            {inspectorLabel} ({remainingMatches.length}) — inspection only
          </summary>
          <div className="hint" style={{ margin: '10px 0 14px' }}>
            {settings.summaryMode === 'deep' ? 'Deep Search reads complete Swami units from these neighbors and may discard any of them.' : 'These are retrieval neighbors, not accepted answers and not Verbatim Selection evidence.'}
          </div>
          <div className="qa-results">
            {remainingMatches.map((match, index) => (
              <MatchRecord
                match={match}
                searchMode={result?.searchMode || settings.searchMode}
                onOpenDocument={setViewerRequest}
                label={acceptedMatch ? 'Related / nearest source' : 'Nearest source'}
                key={`${match.sourceId ?? 'match'}:${match.relevanceRank ?? index}`}
              />
            ))}
          </div>
        </details>
      ) : null}
      <DocumentViewer runtime={runtime} indexConnection={settings.indexConnection} request={viewerRequest} onClose={() => setViewerRequest(null)} />
    </div>
  );
}

function DiscoursesScreen({ runtime, settings, onNavigate }) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [viewerRequest, setViewerRequest] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = connectionConfigured(settings.indexConnection);
  const load = async (nextPage = page, nextQuery = submittedQuery) => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      setResult(await api(runtime, '/documents/list', { body: { indexConnection: settings.indexConnection, query: nextQuery, page: nextPage, pageSize: 50 }, timeoutMs: 60000 }));
    } catch (loadError) { setError(loadError.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(page, submittedQuery); }, [page, submittedQuery, ready]);
  if (!ready) return <div className="card qa-empty-state"><h3>Index database credentials are required</h3><button className="btn primary" onClick={() => onNavigate('settings')}>Open Settings</button></div>;
  const pages = Math.max(1, Math.ceil(Number(result?.total || 0) / Number(result?.pageSize || 50)));
  return <div className="qa-stack">
    <form className="card qa-discourse-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedQuery(query.trim()); }}><div className="qa-card-title"><div><h3>Browse Discourses</h3><div className="hint">Searches every discourse question and its complete answer content. Open a card to reconstruct all ordered chunks.</div></div><span className="badge">{result?.total ?? '—'} discourses</span></div><div className="toolbar"><input style={{ flex: 1, minWidth: 240 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search questions and full answers…" /><button className="btn primary" disabled={busy}>{busy ? 'Searching…' : 'Search discourses'}</button>{submittedQuery ? <button className="btn" type="button" onClick={() => { setQuery(''); setPage(1); setSubmittedQuery(''); }}>Clear</button> : null}</div></form>
    {error ? <div className="alert warn">{error}</div> : null}
    {!busy && result && !(result.documents || []).length ? <div className="card qa-empty-state"><h3>No matching discourses</h3><div className="hint">No question or answer content matched “{submittedQuery}”.</div></div> : null}
    <div className="qa-discourse-list">{(result?.documents || []).map((document) => {
      const highlightStart = document.highlightStart == null ? null : Number(document.highlightStart);
      const highlightEnd = document.highlightEnd == null ? null : Number(document.highlightEnd);
      const highlights = Number.isInteger(highlightStart) && Number.isInteger(highlightEnd) && highlightEnd > highlightStart
        ? [{ sourceId: document.previewSourceId || document.firstSourceId, start: highlightStart, end: highlightEnd, label: 'Browse search match' }]
        : [];
      return <button className="card qa-discourse-card" type="button" key={document.sourceGroup} onClick={() => setViewerRequest({ reference: document.sourceGroup, title: document.title, highlights })}>
        <div className="qa-discourse-card-top"><span className="badge">{document.matchKind || 'Discourse'}</span><span className="hint">{document.sourceGroup}</span></div>
        <div className="qa-discourse-question"><span className="qa-preview-label">Question</span><strong>{document.title}</strong></div>
        <div className="qa-discourse-answer"><span className="qa-preview-label">Answer preview</span><p>{document.answerPreview || 'No answer preview is available.'}</p></div>
        <div className="qa-discourse-card-footer"><span className="hint">{document.language || 'Unknown language'} · {document.chunkCount} chunk{document.chunkCount === 1 ? '' : 's'}</span><span className="qa-open-discourse">Open full discourse →</span></div>
      </button>;
    })}</div>
    <div className="toolbar qa-pagination"><button className="btn" disabled={busy || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span className="badge">Page {page} of {pages}</span><button className="btn" disabled={busy || page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
    <DocumentViewer runtime={runtime} indexConnection={settings.indexConnection} request={viewerRequest} onClose={() => setViewerRequest(null)} />
  </div>;
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
  const [hardware, setHardware] = useState(null);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [hardwareError, setHardwareError] = useState('');
  const selectedSchema = catalog.find((schema) => schema.name === settings.mapping.schema);
  const selectedTable = selectedSchema?.tables.find((table) => table.name === settings.mapping.table);
  const columns = selectedTable?.columns || [];

  const updateConnection = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const updateMapping = (patch) => setSettings((current) => ({ ...current, mapping: { ...current.mapping, ...patch } }));

  const detectHardware = async () => {
    setHardwareBusy(true);
    setHardwareError('');
    try {
      const response = await api(runtime, '/ollama/hardware', {
        body: { ollamaBaseUrl: settings.ollamaBaseUrl, model: settings.deepSummaryModel },
        timeoutMs: 30000,
      });
      setHardware(response.hardware);
      return response.hardware;
    } catch (error) {
      setHardware(null);
      setHardwareError(error.message);
      return null;
    } finally { setHardwareBusy(false); }
  };

  useEffect(() => {
    const timer = setTimeout(() => { void detectHardware(); }, 250);
    return () => clearTimeout(timer);
  }, [runtime.apiBasePath, settings.ollamaBaseUrl, settings.deepSummaryModel]);

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
    setSettings((current) => ({
      ...current,
      mapping: reconcileCatalogMapping(response.schemas || [], current.mapping),
    }));
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
          <label className="field"><span className="field-label">Deep Search reasoning model</span><select value={settings.deepSummaryModel} onChange={(event) => setSettings((current) => ({ ...current, deepSummaryModel: event.target.value }))}><option value="qwen3:14b-q8_0">qwen3:14b-q8_0 (default)</option><option value="qwen3:14b-q4_K_M">qwen3:14b-q4_K_M</option></select><span className="hint">Thinking is mandatory. Gemma and other non-thinking models are rejected.</span></label>
          <label className="field"><span className="field-label">Deep Search processor</span><select value={settings.summaryHardwarePreference} onChange={(event) => setSettings((current) => ({ ...current, summaryHardwarePreference: event.target.value }))}><option value="auto">Auto (recommended)</option><option value="gpu">Prefer GPU</option><option value="cpu">CPU only</option></select><span className="hint">Auto lets Ollama choose. Prefer GPU requests maximum layer offload; CPU only disables GPU offload.</span></label>
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}><button className="btn" disabled={busy} onClick={() => call('/ollama/test', { ollamaBaseUrl: settings.ollamaBaseUrl, model: settings.model }, (response) => `Ollama connected; ${response.model} returns ${response.dimension} dimensions.`)}>Test Ollama</button><button className="btn" disabled={hardwareBusy} onClick={() => void detectHardware()}>{hardwareBusy ? 'Detecting hardware…' : 'Refresh hardware detection'}</button></div>
        {hardware ? <div className="qa-hardware-panel">
          <div><span>Detected GPU</span><strong>{hardware.host?.accelerators?.length ? hardware.host.accelerators.map((item) => `${item.name}${item.backend ? ` (${item.backend})` : ''}`).join(', ') : 'None detected'}</strong></div>
          <div><span>CPU</span><strong>{hardware.host?.cpu?.name || 'Unknown'} · {hardware.host?.cpu?.logicalCores || '—'} logical cores</strong></div>
          <div><span>Summary model allocation</span><strong>{hardware.runtime?.processor || 'Not loaded yet'}</strong></div>
          <div><span>Recommendation</span><strong>Auto{hardware.gpuAvailable ? ' — GPU is available' : ' — CPU fallback'}</strong></div>
        </div> : null}
        {hardwareError ? <div className="hint" style={{ marginTop: 10 }}>Hardware detection: {hardwareError}</div> : null}
        {settings.summaryHardwarePreference === 'gpu' && hardware && !hardware.gpuAvailable ? <div className="alert warn" style={{ marginTop: 12 }}>No compatible GPU was detected. Ollama may fall back to CPU or reject forced GPU offload.</div> : null}
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
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Verbatim source pool</span><input type="number" min="1" max="15" value={settings.summaryMaxRecords} onChange={(event) => setSettings((current) => ({ ...current, summaryMaxRecords: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Maximum selected teachings</span><input type="number" min="1" max="5" value={settings.summaryMaxLines} onChange={(event) => setSettings((current) => ({ ...current, summaryMaxLines: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Source page size</span><input type="number" min="25" max="1000" value={settings.fetchSize} onChange={(event) => setSettings((current) => ({ ...current, fetchSize: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Embedding batch size</span><input type="number" min="1" max="64" value={settings.embeddingBatchSize} onChange={(event) => setSettings((current) => ({ ...current, embeddingBatchSize: Number(event.target.value) }))} /></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Deep Search candidate limit</span><input type="number" min="1" max="100" value={settings.deepSummaryMaxRecords} onChange={(event) => setSettings((current) => ({ ...current, deepSummaryMaxRecords: Number(event.target.value) }))} /><span className="hint">Complete answer units from this many fused source candidates can enter adjudication.</span></label>
          <label className="field" style={{ gridColumn: 'span 3' }}><span className="field-label">Qwen request limit (seconds)</span><input type="number" min="60" max="600" step="30" value={settings.deepSummaryTimeoutSeconds} onChange={(event) => setSettings((current) => ({ ...current, deepSummaryTimeoutSeconds: Number(event.target.value) }))} /><span className="hint">One Qwen generation runs at a time. Each call is capped at ten minutes; the complete job is capped at 45 minutes.</span></label>
        </div>
        <label className="field" style={{ marginTop: 12, maxWidth: 360 }}><span className="field-label">Default answer mode</span><select value={settings.summaryMode} onChange={(event) => setSettings((current) => ({ ...current, summaryMode: event.target.value, summaryEnabled: event.target.value === 'standard' }))}><option value="off">No Summary</option><option value="standard">Verbatim Selection</option><option value="deep">Deep Search</option></select></label>
        <div className="hint" style={{ marginTop: 10 }}>Both answer modes display only exact stored Swami text. Deep Search adds role-aware complete-answer reading and independent adjudication.</div>
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
    if (tab === 'discourses') return <DiscoursesScreen runtime={runtime} settings={settings} onNavigate={setTab} />;
    if (tab === 'index') return <IndexScreen runtime={runtime} settings={settings} />;
    if (tab === 'settings') return <SettingsScreen runtime={runtime} settings={settings} setSettings={setSettings} catalog={catalog} setCatalog={setCatalog} />;
    return <SearchScreen runtime={runtime} settings={settings} setSettings={setSettings} onNavigate={setTab} />;
  }, [tab, runtime.apiBasePath, settings, catalog]);

  return (
    <div className="semantic-qa">
      <div className="panel">
        <div className="panel-header">
          <div><h3 style={{ margin: 0 }}>Search Engine</h3><div className="hint" style={{ marginTop: 5 }}>Semantic and conventional search with grounded summaries and complete source documents.</div></div>
          <div className="tabs" role="tablist">{[['setup', 'Setup'], ['search', 'Search'], ['discourses', 'Discourses'], ['index', 'Index'], ['settings', 'Settings']].map(([id, label]) => <button key={id} className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
        </div>
        <div className="panel-body">{screen}</div>
      </div>
    </div>
  );
}

export { STANDALONE_RUNTIME };
