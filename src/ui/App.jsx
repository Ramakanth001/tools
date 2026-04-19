import React, { useEffect, useMemo, useState } from 'react';
import { TOOLS, findToolByPath } from './registry.js';

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
  const activeTool = useMemo(() => findToolByPath(pathname), [pathname]);

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
                <div className="toolbar">
                  <button className="btn primary" type="button" onClick={() => navigate(tool.path, setPathname)}>
                    Open tool
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
