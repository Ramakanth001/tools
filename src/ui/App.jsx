import React, { useEffect, useMemo, useState } from 'react';
import { TOOLS, findToolByPath } from './registry.js';

function getAuthHeaders() {
  if (typeof window === 'undefined') return {};
  const fromUrl = new URLSearchParams(window.location.search).get('token') || '';
  if (fromUrl) localStorage.setItem('tools.authToken', fromUrl);
  const token = fromUrl || localStorage.getItem('tools.authToken') || '';
  return token ? { 'x-tools-auth': token } : {};
}

async function requestSetupCheck(toolId) {
  const response = await fetch(`/api/tools/${encodeURIComponent(toolId)}/setup-check`, {
    headers: getAuthHeaders(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || response.statusText || 'Setup check failed');
  }
  return payload;
}

function SetupCheckResult({ state }) {
  if (!state || state.status === 'checking') return null;
  if (state.status === 'error') {
    return <div className="workspace-setup-error" role="alert">{state.error}</div>;
  }

  const report = state.report;
  return (
    <div className={`workspace-setup-result ${report.ready ? 'is-ready' : 'needs-setup'}`} aria-live="polite">
      <div className="workspace-setup-summary">
        <strong>{report.ready ? 'Setup looks ready' : 'Setup required'}</strong>
        <span className="hint">Checked from <code>{report.requirementsFile}</code></span>
      </div>
      <div className="workspace-setup-checks">
        {report.checks.map((check) => (
          <div className="workspace-setup-check" key={check.id}>
            <span className={`workspace-setup-dot ${check.ok ? 'ok' : 'error'}`} aria-hidden="true" />
            <div>
              <strong>{check.label}{!check.required ? ' (optional)' : ''}</strong>
              <div className="hint">{check.detail}</div>
              {!check.ok && check.fix ? <div className="workspace-setup-fix">{check.fix}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {!report.ready && report.setupCommand ? (
        <div className="workspace-setup-command">
          <span>Suggested setup</span>
          <code>{report.setupCommand}</code>
        </div>
      ) : null}
    </div>
  );
}

function usePathname() {
  const [pathname, setPathname] = useState(() => (typeof window !== 'undefined' ? window.location.pathname : '/'));

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return [pathname, setPathname];
}

function navigate(to, setPathname) {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  setPathname(to);
}

export default function App() {
  const [pathname, setPathname] = usePathname();
  const [setupChecks, setSetupChecks] = useState({});
  const activeTool = useMemo(() => findToolByPath(pathname), [pathname]);

  async function checkSetup(toolId) {
    setSetupChecks((current) => ({ ...current, [toolId]: { status: 'checking' } }));
    try {
      const report = await requestSetupCheck(toolId);
      setSetupChecks((current) => ({ ...current, [toolId]: { status: 'done', report } }));
    } catch (error) {
      setSetupChecks((current) => ({
        ...current,
        [toolId]: { status: 'error', error: error.message || 'Setup check failed' },
      }));
    }
  }

  if (activeTool) {
    const ToolComponent = activeTool.component;
    return (
      <div className="container">
        <div className="topbar">
          <div className="brand">
            <div className="logo" aria-hidden="true" />
            <div>
              <h1>tools</h1>
              <div className="subtitle">Multi-tool workspace</div>
            </div>
          </div>
          <div className="toolbar">
            <button className="btn" type="button" onClick={() => navigate('/', setPathname)}>
              All tools
            </button>
            <span className="badge">{activeTool.name}</span>
          </div>
        </div>

        <ToolComponent runtime={activeTool.runtime} />
      </div>
    );
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <div>
            <h1>tools</h1>
            <div className="subtitle">Shared host for multiple local tools</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3 style={{ margin: 0 }}>Available tools</h3>
            <div className="hint" style={{ marginTop: 6 }}>Each tool can have its own UI and API, mounted inside this shared host.</div>
          </div>
          <div className="toolbar">
            <span className="badge">Platform shell</span>
          </div>
        </div>

        <div className="panel-body">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {TOOLS.map((tool) => (
              <div key={tool.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <h3 style={{ marginBottom: 6 }}>{tool.name}</h3>
                  <div className="hint">{tool.description}</div>
                </div>
                <SetupCheckResult state={setupChecks[tool.id]} />
                <div className="toolbar">
                  <button className="btn primary" type="button" onClick={() => navigate(tool.path, setPathname)}>
                    Open tool
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void checkSetup(tool.id)}
                    disabled={setupChecks[tool.id]?.status === 'checking'}
                  >
                    {setupChecks[tool.id]?.status === 'checking' ? 'Checking…' : 'Check setup'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
