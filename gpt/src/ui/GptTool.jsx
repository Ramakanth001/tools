import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, streamApi } from './api.js';
import { exportAnswer, exportConversationPdf, questionForMessage } from './export.mjs';
import { CHAT_MODELS, CONTEXT_OPTIONS, TEMPERATURE_PRESETS, DEFAULT_SETTINGS, mergeSettings, stripSecrets } from './settings.mjs';
import './gpt.css';

export const STANDALONE_RUNTIME = {
  toolId: 'gpt', apiBasePath: '/api', homePath: '/', storagePrefix: 'tools.gpt',
};

function InlineText({ content, sources, onSource }) {
  const byNumber = new Map((sources || []).map((source) => [Number(source.citationNumber), source]));
  return String(content || '').split(/(\[\d+\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/gu).map((part, index) => {
    const match = part.match(/^\[(\d+)\]$/u);
    if (match) {
      const source = byNumber.get(Number(match[1]));
      return source ? <button key={index} type="button" className="gpt-citation" onClick={() => onSource(source)}>{part}</button> : part;
    }
    if (/^\*\*[^*]+\*\*$/u.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/u.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/u);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function MarkdownContent({ content, sources, onSource }) {
  const lines = String(content || '').replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  const inline = (value, key) => <InlineText key={key} content={value} sources={sources} onSource={onSource} />;
  const isTableSeparator = (value) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(value);
  const cells = (value) => value.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim());
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) code.push(lines[index++]);
      index += 1;
      blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      const header = cells(line); index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push(<div className="gpt-table-wrap" key={`table-${index}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, cellIndex)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, cellIndex)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      const Heading = `h${Math.min(4, heading[1].length + 2)}`;
      blocks.push(<Heading key={`heading-${index}`}>{inline(heading[2], index)}</Heading>); index += 1; continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/u.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/u, ''));
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, itemIndex)}</li>)}</ul>); continue;
    }
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/u, ''));
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, itemIndex)}</li>)}</ol>); continue;
    }
    if (/^>\s?/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/u, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{inline(quote.join('\n'), index)}</blockquote>); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^\s*[-*]\s+|^\s*\d+[.)]\s+|^>|^```/u.test(lines[index]) && !(lines[index].includes('|') && isTableSeparator(lines[index + 1] || ''))) paragraph.push(lines[index++]);
    blocks.push(<p key={`paragraph-${index}`}>{inline(paragraph.join('\n'), index)}</p>);
  }
  return blocks;
}

function ExportMenu({ title, message }) {
  const menuRef = useRef(null);
  const choose = (format) => {
    exportAnswer({ format, title, message });
    menuRef.current?.removeAttribute('open');
  };
  return <details className="gpt-export-menu" ref={menuRef}>
    <summary>Export</summary>
    <div className="gpt-export-options">
      <button type="button" onClick={() => choose('pdf')}><strong>PDF</strong><small>Print or save as PDF</small></button>
      <button type="button" onClick={() => choose('doc')}><strong>DOC</strong><small>Open in Microsoft Word</small></button>
      <button type="button" onClick={() => choose('html')}><strong>HTML</strong><small>Styled standalone page</small></button>
      <button type="button" onClick={() => choose('txt')}><strong>TXT</strong><small>Plain text document</small></button>
    </div>
  </details>;
}

function Message({ message, question, onSource, onRegenerate, isLatestAssistant }) {
  const assistant = message.role === 'assistant';
  return <article className={`gpt-message ${message.role}`}>
    <div className="gpt-avatar" aria-hidden="true">{assistant ? 'G' : 'Y'}</div>
    <div className="gpt-message-body">
      <div className="gpt-message-label">{assistant ? 'GPT' : 'You'}</div>
      <div className="gpt-message-content"><MarkdownContent content={message.content} sources={message.sources} onSource={onSource} /></div>
      {assistant ? <div className="gpt-message-actions">
        <button type="button" onClick={() => navigator.clipboard.writeText(message.content)}>Copy</button>
        <ExportMenu title={question || 'GPT corpus answer'} message={message} />
        {isLatestAssistant ? <button type="button" onClick={() => onRegenerate(message.turnId)}>Regenerate</button> : null}
        {message.sources?.length ? <span>{message.sources.length} verified {message.sources.length === 1 ? 'source' : 'sources'}</span> : null}
      </div> : null}
      {assistant && message.sources?.length ? <section className="gpt-citations-panel" aria-label="All relevant corpus citations">
        <div className="gpt-citations-heading"><strong>All relevant citations</strong><span>{message.sources.length} verified corpus {message.sources.length === 1 ? 'passage' : 'passages'}</span></div>
        <div className="gpt-citations-list">{message.sources.map((source) => <button type="button" className="gpt-citation-card" key={source.key || `${source.sourceId}:${source.citationNumber}`} onClick={() => onSource(source)}>
          <span className="gpt-citation-number">[{source.citationNumber}]</span>
          <span className="gpt-citation-details"><strong>{source.title || `Source ${source.sourceId}`}</strong><span>{source.excerpt}</span><small>{source.cited ? 'Used in the main answer' : 'Additional relevant evidence'} · Source {source.sourceId} · Open passage</small></span>
        </button>)}</div>
      </section> : null}
      {assistant && (message.researchDetails?.probes || message.researchDetails?.candidates) ? <details className="gpt-research-details"><summary>Research details</summary><div><span>{message.researchDetails.probes || 0} queries</span><span>{message.researchDetails.accepted || message.sources?.length || 0} sources reviewed</span>{message.researchDetails.repaired ? <span>Draft repaired</span> : null}</div></details> : null}
    </div>
  </article>;
}

function ConnectionFields({ title, value, onChange }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  return <div className="card gpt-settings-card">
    <h3>{title}</h3>
    <label className="field full"><span className="field-label">Connection string (memory only, optional)</span><input type="password" value={value.connectionString || ''} onChange={(event) => set('connectionString', event.target.value)} /></label>
    <div className="form-grid">
      <label className="field"><span className="field-label">Host</span><input value={value.host} onChange={(event) => set('host', event.target.value)} /></label>
      <label className="field"><span className="field-label">Port</span><input type="number" value={value.port} onChange={(event) => set('port', Number(event.target.value))} /></label>
      <label className="field"><span className="field-label">Database</span><input value={value.database} onChange={(event) => set('database', event.target.value)} /></label>
      <label className="field"><span className="field-label">User</span><input value={value.user} onChange={(event) => set('user', event.target.value)} /></label>
      <label className="field"><span className="field-label">Password (memory only)</span><input type="password" value={value.password || ''} onChange={(event) => set('password', event.target.value)} /></label>
      <label className="field"><span className="field-label">SSL</span><select value={value.sslMode} onChange={(event) => set('sslMode', event.target.value)}><option value="disable">Disable</option><option value="prefer">Prefer</option><option value="require">Require</option><option value="verify-full">Verify full</option></select></label>
    </div>
  </div>;
}

function SetupStatus({ ready, label, detail }) {
  return <div className="gpt-setup-status"><span className={ready ? 'ready' : ''}>{ready ? '✓' : '•'}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function researchStatusDetail(stage, elapsed) {
  const detail = {
    starting: 'Preparing the local research pipeline',
    understanding: 'Resolving the question and conversation context',
    searching: 'Embedding the query and searching the read-only corpus',
    comparing: 'Rejecting merely topical matches and retaining useful support',
    reading: 'Adding nearby passages so quotations are not taken out of context',
    extracting: 'Selecting and validating exact answer spans word for word',
    drafting: 'Synthesizing a detailed answer across the accepted passages',
    verifying: 'Removing or narrowing anything the cited excerpts do not support',
  }[stage] || 'Working against the local corpus';
  return `${detail} · ${elapsed}s elapsed`;
}

function Setup({ runtime, settings, setSettings, health, busy, error, onSave, onRefreshHealth }) {
  const [setupStatus, setSetupStatus] = useState(null);
  const [adminConnection, setAdminConnection] = useState({ connectionString: '', host: '127.0.0.1', port: 5433, user: '', password: '', database: 'postgres', sslMode: 'disable' });
  const [databaseBusy, setDatabaseBusy] = useState(false);
  const [databaseProvisioned, setDatabaseProvisioned] = useState(false);
  const [pullingModel, setPullingModel] = useState('');
  const [failedModel, setFailedModel] = useState('');
  const [pullProgress, setPullProgress] = useState(null);
  const [setupMessage, setSetupMessage] = useState('');
  const [setupError, setSetupError] = useState('');
  const pullAbort = useRef(null);
  const benchmarks = health?.checks?.benchmarks?.details || [];
  const ollamaDetails = health?.checks?.ollama?.details || {};
  const loadedBytes = (ollamaDetails.loaded || []).reduce((sum, model) => sum + Number(model.size || 0), 0);
  const models = setupStatus?.ollama?.models || ['embeddinggemma', ...CHAT_MODELS].map((model) => ({ model, installed: false }));
  const installedCount = models.filter((model) => model.installed).length;
  const databaseReady = databaseProvisioned || (health?.checks?.chatDatabase?.status === 'ready' && health?.checks?.corpus?.status === 'ready');
  const ollamaReady = health?.checks?.ollama?.status === 'ready';
  const modelsReady = Boolean(models.find((model) => model.model === 'embeddinggemma')?.installed && settings.chatModel && models.find((model) => model.model === settings.chatModel)?.installed);

  async function refreshSetupStatus() {
    const payload = await api(runtime, `/setup/status?ollamaBaseUrl=${encodeURIComponent(settings.ollamaBaseUrl)}`);
    setSetupStatus(payload);
    setAdminConnection((current) => current.user ? current : { ...current, ...payload.database.adminConnection, password: '' });
    return payload;
  }

  useEffect(() => {
    refreshSetupStatus().catch((reason) => setSetupError(reason.message));
    return () => pullAbort.current?.abort();
  }, [runtime.apiBasePath]);

  async function provisionDatabase() {
    if (!window.confirm('Create the two fixed GPT roles, the spiritual_gpt database, and read-only corpus grants on this local PostgreSQL server?')) return;
    setDatabaseBusy(true); setSetupError(''); setSetupMessage('Connecting to local PostgreSQL…');
    try {
      const payload = await api(runtime, '/setup/database', { method: 'POST', body: JSON.stringify({
        adminConnection,
        indexDatabase: settings.indexConnection.database,
        indexRolePassword: settings.indexConnection.password || '',
        chatRolePassword: settings.chatConnection.password || '',
      }) });
      setDatabaseProvisioned(true);
      setSetupMessage(`Created or verified ${payload.result.indexRole}, ${payload.result.chatRole}, and ${payload.result.chatDatabase}.`);
      await onRefreshHealth().catch(() => undefined);
    } catch (reason) { setSetupError(reason.message); setSetupMessage(''); }
    finally { setDatabaseBusy(false); }
  }

  async function pullOne(model) {
    const controller = new AbortController(); pullAbort.current = controller;
    let streamError = '';
    setFailedModel('');
    setPullingModel(model); setPullProgress({ model, message: 'Preparing download', percent: null });
    try {
      await streamApi(runtime, '/setup/models/pull', { model, ollamaBaseUrl: settings.ollamaBaseUrl }, { signal: controller.signal, onEvent: (event) => {
        if (event.type === 'progress' || event.type === 'status') setPullProgress({ model, message: event.message, percent: event.percent });
        if (event.type === 'error') streamError = event.error;
        if (event.type === 'done') setPullProgress({ model, message: event.message, percent: 100 });
      } });
      if (streamError) throw new Error(streamError);
      await refreshSetupStatus();
      setFailedModel('');
    } catch (reason) {
      if (reason.name !== 'AbortError') {
        setFailedModel(model);
        setPullProgress((current) => ({ ...(current || { model, percent: null }), message: 'Download paused — fix the connection, then press Retry' }));
      }
      throw reason;
    }
  }

  async function installModels(requested) {
    setSetupError(''); setSetupMessage('');
    try {
      for (const model of requested) await pullOne(model);
      setSetupMessage(`${requested.length === 1 ? requested[0] : 'All required local models'} installed successfully.`);
      await onRefreshHealth().catch(() => undefined);
    } catch (reason) {
      if (reason.name !== 'AbortError') setSetupError(reason.message);
    } finally { setPullingModel(''); pullAbort.current = null; }
  }

  function updateAdmin(key, value) { setAdminConnection((current) => ({ ...current, [key]: value })); }

  return <div className="gpt-setup">
    <div className="gpt-setup-heading">
      <div><span className="gpt-eyebrow">Local-only setup</span><h2>Connect GPT to the corpus</h2><p>GPT reads the existing vector index with a read-only account and stores chats in a separate PostgreSQL database.</p></div>
      <div className={`gpt-readiness ${health?.ready ? 'ready' : ''}`}><span />{health?.ready ? 'Ready' : 'Setup required'}</div>
    </div>
    {error || setupError ? <div className="alert error">{setupError || error}</div> : null}
    {setupMessage ? <div className="alert gpt-setup-success">{setupMessage}</div> : null}

    <div className="card gpt-onboarding">
      <div className="gpt-onboarding-head"><div><span className="gpt-eyebrow">Guided setup</span><h3>Make the local researcher ready</h3><p>Complete these once. Passwords stay in process memory and model downloads go directly to local Ollama.</p></div><button type="button" className="btn" onClick={() => refreshSetupStatus().catch((reason) => setSetupError(reason.message))}>Refresh status</button></div>
      <div className="gpt-setup-steps">
        <section className="gpt-setup-step">
          <span className="gpt-step-number">1</span><h4>Create local database access</h4>
          <p>Create the read-only corpus role and the separate conversation database. Existing Search Engine tables are never altered or rebuilt.</p>
          <SetupStatus ready={databaseReady} label={databaseReady ? 'Databases connected' : 'Provisioning required'} detail="spiritual_gpt_index_reader + spiritual_gpt_app" />
          <details className="gpt-advanced"><summary>Administrator and role passwords</summary>
            <div className="form-grid">
              <label className="field"><span className="field-label">Admin host</span><input value={adminConnection.host} onChange={(event) => updateAdmin('host', event.target.value)} /></label>
              <label className="field"><span className="field-label">Admin port</span><input type="number" value={adminConnection.port} onChange={(event) => updateAdmin('port', Number(event.target.value))} /></label>
              <label className="field"><span className="field-label">Admin user</span><input value={adminConnection.user} onChange={(event) => updateAdmin('user', event.target.value)} /></label>
              <label className="field"><span className="field-label">Admin password</span><input type="password" autoComplete="off" value={adminConnection.password} onChange={(event) => updateAdmin('password', event.target.value)} /></label>
              <label className="field"><span className="field-label">Corpus-role password</span><input type="password" autoComplete="new-password" value={settings.indexConnection.password || ''} onChange={(event) => setSettings((current) => ({ ...current, indexConnection: { ...current.indexConnection, password: event.target.value } }))} /></label>
              <label className="field"><span className="field-label">Chat-role password</span><input type="password" autoComplete="new-password" value={settings.chatConnection.password || ''} onChange={(event) => setSettings((current) => ({ ...current, chatConnection: { ...current.chatConnection, password: event.target.value } }))} /></label>
            </div><small>Leave passwords blank for this workspace’s localhost-only trust authentication.</small>
          </details>
          <button type="button" className="btn primary" disabled={databaseBusy || !adminConnection.user} onClick={provisionDatabase}>{databaseBusy ? 'Creating…' : 'Create databases & roles'}</button>
        </section>

        <section className="gpt-setup-step">
          <span className="gpt-step-number">2</span><h4>Install local AI models</h4>
          <p>EmbeddingGemma searches the corpus. Both Qwen quantizations are installed so the accuracy benchmark can compare them.</p>
          <div className="gpt-no-docker-note"><strong>No Docker needed.</strong> Ollama’s “docker/registry” error path describes its model registry format, not Docker Desktop.</div>
          <div className="gpt-model-installs">{models.map((entry) => <div key={entry.model}><span className={entry.installed ? 'installed' : failedModel === entry.model ? 'failed' : ''}>{entry.installed ? '✓' : failedModel === entry.model ? '!' : '↓'}</span><strong>{entry.model}</strong><button type="button" className="btn" disabled={Boolean(pullingModel) || entry.installed} onClick={() => installModels([entry.model])}>{entry.installed ? 'Installed' : failedModel === entry.model ? 'Retry' : 'Install'}</button></div>)}</div>
          {pullProgress ? <div className="gpt-pull-progress"><div><span>{pullProgress.model}</span><strong>{pullProgress.percent == null ? '…' : `${pullProgress.percent}%`}</strong></div><div className="gpt-progress"><span style={{ width: `${pullProgress.percent || 3}%` }} /></div><small>{pullProgress.message}</small></div> : null}
          <div className="toolbar"><button type="button" className="btn primary" disabled={Boolean(pullingModel) || installedCount === models.length || !setupStatus?.ollama?.available} onClick={() => installModels(models.filter((entry) => !entry.installed).map((entry) => entry.model))}>{pullingModel ? `Installing ${pullingModel}…` : 'Install missing models'}</button>{pullingModel ? <button type="button" className="btn" onClick={() => pullAbort.current?.abort()}>Cancel</button> : null}</div>
          {!setupStatus?.ollama?.available ? <small className="gpt-step-warning">Start Ollama first: <code>brew services start ollama</code></small> : null}
        </section>

        <section className="gpt-setup-step">
          <span className="gpt-step-number">3</span><h4>Choose and verify Qwen</h4>
          <p>Select either quantization now, or run the supplied benchmark later and use its accuracy-first recommendation.</p>
          <label className="field"><span className="field-label">Qwen model</span><select value={settings.chatModel} onChange={(event) => setSettings((current) => ({ ...current, chatModel: event.target.value }))}><option value="">Select a model…</option>{CHAT_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          <SetupStatus ready={ollamaReady || modelsReady} label={ollamaReady ? 'Selected models verified' : modelsReady ? 'Models installed; verify next' : 'Verification pending'} detail="Embedding model, Qwen, digest, and corpus contract" />
          <button type="button" className="btn primary" disabled={busy || !settings.chatModel} onClick={onSave}>{busy ? 'Verifying…' : 'Save & run diagnostics'}</button>
        </section>

        <section className="gpt-setup-step">
          <span className="gpt-step-number">4</span><h4>Open GPT</h4>
          <p>Once every check passes, Chat opens automatically. The same tool is available inside this workspace and as a standalone local service.</p>
          <pre className="gpt-command">npm run dev:gpt{`\n\n`}npm run build:gpt{`\n`}npm run start:gpt</pre>
          <SetupStatus ready={health?.ready} label={health?.ready ? 'GPT is ready' : 'Finish the checks above'} detail="Standalone UI :5178 · production/API :8793" />
        </section>
      </div>
    </div>

    <div className="gpt-section-heading"><div><span className="gpt-eyebrow">Connection details</span><h3>Review local database settings</h3></div><span>Advanced</span></div>
    <div className="gpt-settings-grid">
      <ConnectionFields title="Read-only corpus index" value={settings.indexConnection} onChange={(value) => setSettings((current) => ({ ...current, indexConnection: value }))} />
      <ConnectionFields title="Conversation database" value={settings.chatConnection} onChange={(value) => setSettings((current) => ({ ...current, chatConnection: value }))} />
    </div>
    <div className="card gpt-settings-card">
      <h3>Local models</h3>
      <div className="form-grid">
        <label className="field"><span className="field-label">Ollama URL</span><input value={settings.ollamaBaseUrl} onChange={(event) => setSettings((current) => ({ ...current, ollamaBaseUrl: event.target.value }))} /></label>
        <label className="field"><span className="field-label">Embedding model</span><input value={settings.embeddingModel} onChange={(event) => setSettings((current) => ({ ...current, embeddingModel: event.target.value }))} /></label>
        <label className="field"><span className="field-label">Qwen model</span><select value={settings.chatModel} onChange={(event) => setSettings((current) => ({ ...current, chatModel: event.target.value }))}>
          <option value="">Choose after benchmarking or select explicitly…</option>{CHAT_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
        </select><span className="field-hint">Both quantizations remain available. No default is assumed before local evaluation.</span></label>
        <label className="field"><span className="field-label">Processor preference</span><select value={settings.hardwarePreference} onChange={(event) => setSettings((current) => ({ ...current, hardwarePreference: event.target.value }))}><option value="auto">Auto</option><option value="gpu">Prefer GPU</option><option value="cpu">CPU only</option></select></label>
        <label className="field"><span className="field-label">Context memory budget</span><select value={settings.contextTokens} onChange={(event) => setSettings((current) => ({ ...current, contextTokens: Number(event.target.value) }))}>{CONTEXT_OPTIONS.map((tokens) => <option key={tokens} value={tokens}>{tokens === 8192 ? '8K · Memory safe (recommended)' : tokens === 12288 ? '12K · Larger comparisons' : '16K · Highest memory use'}</option>)}</select></label>
        <label className="field"><span className="field-label">Answer temperature</span><select value={settings.responseTemperature} onChange={(event) => setSettings((current) => ({ ...current, responseTemperature: Number(event.target.value) }))}>{TEMPERATURE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label} · {preset.description}</option>)}</select><span className="field-hint">At 0.1 the answer is copied word for word from corpus sources. Higher settings permit progressively more paraphrasing.</span></label>
        <label className="field"><span className="field-label">After each answer</span><select value={settings.unloadAfterTurn ? 'unload' : 'keep'} onChange={(event) => setSettings((current) => ({ ...current, unloadAfterTurn: event.target.value === 'unload' }))}><option value="unload">Unload Qwen and release RAM</option><option value="keep">Keep Qwen warm for 5 minutes</option></select></label>
      </div>
      <div className="gpt-model-status">
        <span className={models.find((model) => model.model === 'embeddinggemma')?.installed ? 'ok' : ''}>EmbeddingGemma {models.find((model) => model.model === 'embeddinggemma')?.installed ? 'installed' : 'not detected'}</span>
        <span className={models.find((model) => model.model === settings.chatModel)?.installed ? 'ok' : ''}>Selected Qwen {models.find((model) => model.model === settings.chatModel)?.installed ? 'installed' : 'not detected'}</span>
        <span>Context budget {Number(settings.contextTokens).toLocaleString()} tokens</span>
        <span>Answer style {TEMPERATURE_PRESETS.find((preset) => preset.value === settings.responseTemperature)?.label || settings.responseTemperature}</span>
        <span>{settings.unloadAfterTurn ? 'Qwen releases RAM after every answer' : 'Qwen remains warm for 5 minutes'}</span>
        {loadedBytes ? <span>{(loadedBytes / (1024 ** 3)).toFixed(1)} GB currently allocated by Ollama</span> : null}
      </div>
      {benchmarks.length ? <details className="gpt-benchmark"><summary>Recent quantization benchmarks</summary>{benchmarks.map((run) => <pre key={run.id}>{JSON.stringify(run, null, 2)}</pre>)}</details> : <div className="hint gpt-benchmark-note">No benchmark results recorded yet. Use the included corpus benchmark command before choosing the production default.</div>}
      <div className="toolbar"><button type="button" className="btn primary" disabled={busy || !settings.chatModel} onClick={onSave}>{busy ? 'Checking…' : 'Save and verify setup'}</button></div>
    </div>
  </div>;
}

function SourceDrawer({ source, runtime, onClose }) {
  const [document, setDocument] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDocument(null); setError('');
    if (!source) return;
    const query = new URLSearchParams({ passageIndex: String(source.passageIndex), start: String(source.start), end: String(source.end) });
    api(runtime, `/sources/${encodeURIComponent(source.sourceId)}?${query}`)
      .then((payload) => setDocument(payload.source)).catch((reason) => setError(reason.message));
  }, [source, runtime]);
  if (!source) return null;
  const metadata = source.metadata || {};
  return <aside className="gpt-source-drawer">
    <div className="gpt-source-head"><div><span className="gpt-eyebrow">Source {source.citationNumber}</span><h3>{source.title || source.sourceId}</h3></div><button type="button" className="gpt-icon-button" onClick={onClose} aria-label="Close source">×</button></div>
    <div className="gpt-source-meta"><span>{metadata.source_type || 'Corpus source'}</span><span>{metadata.record_date || 'Date unavailable'}</span><span>{source.sourceId}</span></div>
    <div className="gpt-source-excerpt-label">{source.adjudication?.verbatim ? 'Exact answer from corpus' : 'Exact cited source span'}</div>
    <blockquote>{source.excerpt}</blockquote>
    {error ? <div className="alert error">{error}</div> : null}
    {!document && !error ? <div className="gpt-source-loading">Opening full source…</div> : null}
    {document ? <div className="gpt-full-source">
      <h4>Complete source</h4>
      {document.records.map((record) => {
        const selected = record.sourceId === source.sourceId;
        const highlight = selected ? document.highlight : null;
        const answer = String(record.answer || '');
        return <section key={record.sourceId} className={selected ? 'highlighted' : ''}><div className="gpt-source-record-id">{record.sourceId}</div><div>{highlight ? <>{answer.slice(0, highlight.start)}<mark>{answer.slice(highlight.start, highlight.end)}</mark>{answer.slice(highlight.end)}</> : answer}</div></section>;
      })}
    </div> : null}
  </aside>;
}

export default function GptTool({ runtime = STANDALONE_RUNTIME }) {
  const storageKey = `${runtime.storagePrefix || 'tools.gpt'}.settings`;
  const [settings, setSettings] = useState(() => {
    try { return mergeSettings(JSON.parse(localStorage.getItem(storageKey) || '{}')); } catch { return DEFAULT_SETTINGS; }
  });
  const [health, setHealth] = useState(null);
  const [view, setView] = useState('chat');
  const [conversations, setConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState(null);
  const [source, setSource] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef(null);
  const transcriptRef = useRef(null);

  const ready = Boolean(health?.ready);
  const messages = conversation?.messages || [];
  const latestAssistant = useMemo(() => [...(conversation?.messages || [])].reverse().find((message) => message.role === 'assistant'), [conversation]);

  async function refreshHealth() {
    const payload = await api(runtime, '/health'); setHealth(payload); return payload;
  }
  async function refreshServerSettings() {
    const payload = await api(runtime, '/settings');
    setSettings((current) => {
      const merged = mergeSettings(payload.settings || {}, current);
      return {
        ...merged,
        indexConnection: { ...merged.indexConnection, password: current.indexConnection.password || '', connectionString: current.indexConnection.connectionString || '' },
        chatConnection: { ...merged.chatConnection, password: current.chatConnection.password || '', connectionString: current.chatConnection.connectionString || '' },
      };
    });
    return payload;
  }
  async function refreshConversations(selectId) {
    const payload = await api(runtime, '/conversations'); setConversations(payload.conversations);
    const requestedId = selectId || conversation?.id;
    const id = payload.conversations.some((item) => item.id === requestedId) ? requestedId : payload.conversations[0]?.id;
    if (id) await openConversation(id); else setConversation(null);
  }
  async function openConversation(id) {
    const payload = await api(runtime, `/conversations/${id}/messages`); setConversation(payload.conversation); setSource(null); setSidebarOpen(false);
  }

  useEffect(() => {
    Promise.all([refreshHealth(), refreshServerSettings()]).catch((reason) => setError(reason.message));
  }, []);
  useEffect(() => { if (ready) refreshConversations().catch((reason) => setError(reason.message)); }, [ready]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
  }, [conversation?.messages, status]);
  useEffect(() => {
    if (!busy) { setElapsed(0); return undefined; }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function saveSettings() {
    setBusy(true); setError('');
    try {
      await api(runtime, '/settings', { method: 'PUT', body: JSON.stringify(settings) });
      localStorage.setItem(storageKey, JSON.stringify(stripSecrets(settings)));
      const next = await refreshHealth();
      if (next.ready) { setView('chat'); await refreshConversations(); }
      else setError('Connections were saved, but one or more local dependencies are not ready. Review the status above.');
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }

  async function updateRuntimePreference(patch) {
    if (busy || runtimeSaving) return;
    const previous = settings;
    const next = mergeSettings(patch, settings);
    setSettings(next); setRuntimeSaving(true); setError('');
    try {
      await api(runtime, '/settings', { method: 'PUT', body: JSON.stringify(patch) });
      localStorage.setItem(storageKey, JSON.stringify(stripSecrets(next)));
    } catch (reason) {
      setSettings(previous); setError(`Could not save the response setting: ${reason.message}`);
    } finally { setRuntimeSaving(false); }
  }

  async function newConversation() {
    const payload = await api(runtime, '/conversations', { method: 'POST', body: JSON.stringify({ title: 'New conversation' }) });
    await refreshConversations(payload.conversation.id);
  }

  async function renameConversation(item) {
    const title = window.prompt('Rename conversation', item.title);
    if (!title?.trim()) return;
    await api(runtime, `/conversations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    await refreshConversations(item.id);
  }

  async function deleteConversation(item) {
    if (!window.confirm(`Delete “${item.title}” and its local evidence history?`)) return;
    await api(runtime, `/conversations/${item.id}`, { method: 'DELETE' });
    if (conversation?.id === item.id) setConversation(null);
    await refreshConversations();
  }

  async function sendMessage(forcedQuestion = null, regenerateTurnId = null) {
    const question = String(forcedQuestion ?? input).trim();
    if ((!question && !regenerateTurnId) || busy) return;
    setBusy(true); setError(''); setStatus({ stage: 'starting', message: 'Starting local research' }); setActiveTurnId(null);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      let activeConversation = conversation;
      if (!activeConversation) {
        const created = await api(runtime, '/conversations', { method: 'POST', body: JSON.stringify({ title: question }) });
        activeConversation = { ...created.conversation, messages: [] }; setConversation(activeConversation);
      }
      if (!regenerateTurnId) {
        setConversation((current) => ({ ...activeConversation, ...(current || {}), messages: [...(current?.messages || []), { id: `local-${Date.now()}`, role: 'user', content: question, sources: [] }] }));
        setInput('');
      }
      const path = regenerateTurnId ? `/turns/${regenerateTurnId}/regenerate` : `/conversations/${activeConversation.id}/messages`;
      await streamApi(runtime, path, regenerateTurnId ? {} : { content: question }, { signal: controller.signal, onEvent: (event) => {
        if (event.turnId) setActiveTurnId(event.turnId);
        if (event.type === 'status') setStatus({ stage: event.stage, message: event.message });
        if (event.type === 'answer') setConversation((current) => ({ ...current, messages: [...(current?.messages || []), event.message] }));
        if (event.type === 'error') throw new Error(event.error);
      } });
      setStatus(null); setActiveTurnId(null);
      await refreshConversations(activeConversation.id);
    } catch (reason) {
      if (reason.name !== 'AbortError') setError(reason.message);
      setStatus(null);
    } finally { setBusy(false); abortRef.current = null; }
  }

  async function stop() {
    abortRef.current?.abort();
    if (activeTurnId) await api(runtime, `/turns/${activeTurnId}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined);
  }

  const standaloneClass = runtime.apiBasePath === '/api' ? ' standalone' : '';
  if (view === 'setup' || !ready) return <div className={`gpt-tool${standaloneClass}`}><div className="gpt-tool-nav"><button type="button" className="btn" onClick={() => ready && setView('chat')} disabled={!ready}>Chat</button><button type="button" className="btn primary">Setup</button></div><Setup runtime={runtime} settings={settings} setSettings={setSettings} health={health} busy={busy} error={error} onSave={saveSettings} onRefreshHealth={refreshHealth} /></div>;

  return <div className={`gpt-tool${standaloneClass} chat-mode`}>
    <div className="gpt-shell">
      <aside className={`gpt-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="gpt-sidebar-head"><button type="button" className="gpt-new-chat" onClick={newConversation}>＋ New chat</button></div>
        <div className="gpt-conversation-list">{conversations.map((item) => <div key={item.id} className={`gpt-conversation ${conversation?.id === item.id ? 'active' : ''}`}>
          <button type="button" className="gpt-conversation-open" onClick={() => openConversation(item.id)}><span>{item.title}</span><small>{item.messageCount || 0} messages</small></button>
          <div className="gpt-conversation-actions"><button type="button" onClick={() => renameConversation(item)}>✎</button><button type="button" onClick={() => deleteConversation(item)}>×</button></div>
        </div>)}</div>
        <button type="button" className="gpt-settings-link" onClick={() => setView('setup')}>⚙ Setup & models</button>
      </aside>
      {sidebarOpen ? <button type="button" className="gpt-mobile-scrim" aria-label="Close chats" onClick={() => setSidebarOpen(false)} /> : null}
      <main className="gpt-chat">
        <header className="gpt-chat-head"><button type="button" className="gpt-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open chats">☰</button><div className="gpt-chat-title"><span className="gpt-eyebrow">Corpus-only researcher</span><h2>{conversation?.title || 'New conversation'}</h2></div><div className="gpt-chat-head-actions"><button type="button" className="gpt-export-chat" disabled={!messages.length || busy} onClick={() => exportConversationPdf({ title: conversation?.title, messages })}>Export chat PDF</button><span className="gpt-accuracy">Accuracy first · {settings.chatModel.replace('qwen3:14b-', '')}</span></div></header>
        <div className="gpt-transcript" ref={transcriptRef}>
          {!conversation?.messages?.length ? <div className="gpt-welcome"><div className="gpt-welcome-mark">G</div><h2>Research the spiritual corpus</h2><p>Ask a question, compare teachings, trace a relationship, or examine an apparent contradiction. GPT will search, check, and cite only the local corpus.</p><div className="gpt-suggestions">{['Compare two teachings about the nature of the world', 'Explain an apparent contradiction across discourses', 'What does the corpus say about unanswered prayer?'].map((text) => <button type="button" key={text} onClick={() => setInput(text)}>{text}</button>)}</div></div> : null}
          {messages.map((message, messageIndex) => <Message key={message.id} message={message} question={message.role === 'assistant' ? questionForMessage(messages, messageIndex) : ''} onSource={setSource} onRegenerate={(turnId) => sendMessage('', turnId)} isLatestAssistant={message.id === latestAssistant?.id} />)}
          {busy ? <div className="gpt-research-status"><span className="gpt-pulse" /><div><strong>{status?.message || 'Working locally'}</strong><small>{researchStatusDetail(status?.stage, elapsed)}</small></div></div> : null}
          {error ? <div className="alert error gpt-chat-error">{error}</div> : null}
        </div>
        <div className="gpt-composer-wrap"><div className="gpt-runtime-controls">
          <label title="Higher context can help large comparisons but uses more RAM"><span>Context</span><select aria-label="Context budget" value={settings.contextTokens} disabled={busy || runtimeSaving} onChange={(event) => updateRuntimePreference({ contextTokens: Number(event.target.value) })}>{CONTEXT_OPTIONS.map((tokens) => <option key={tokens} value={tokens}>{tokens / 1024}K{tokens === 8192 ? ' · memory safe' : tokens === 12288 ? ' · broader' : ' · maximum'}</option>)}</select></label>
          <label title="At 0.1 answers are copied word for word; higher temperatures paraphrase and synthesize more"><span>Temperature</span><select aria-label="Answer temperature" value={settings.responseTemperature} disabled={busy || runtimeSaving} onChange={(event) => updateRuntimePreference({ responseTemperature: Number(event.target.value) })}>{TEMPERATURE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></label>
          <small>{runtimeSaving ? 'Saving…' : TEMPERATURE_PRESETS.find((preset) => preset.value === settings.responseTemperature)?.description}</small>
        </div><div className="gpt-composer"><textarea rows="1" value={input} disabled={busy} placeholder="Ask the corpus…" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} />
          {busy ? <button type="button" className="gpt-send stop" onClick={stop} aria-label="Stop">■</button> : <button type="button" className="gpt-send" disabled={!input.trim()} onClick={() => sendMessage()} aria-label="Send">↑</button>}
        </div><div className="gpt-composer-note">Local Qwen · EmbeddingGemma · {settings.unloadAfterTurn ? 'Qwen is unloaded after each answer; keeping it warm in Setup makes follow-ups faster.' : 'Qwen stays warm for faster follow-up questions.'}</div></div>
      </main>
      <SourceDrawer source={source} runtime={runtime} onClose={() => setSource(null)} />
    </div>
  </div>;
}
