import React, { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState } from 'reactflow';
import 'reactflow/dist/style.css';

import { api } from '../lib/http.js';
import TableNode from '../schema/nodes/TableNode.jsx';
import { computeElkLayout } from '../schema/layout/elkLayout.js';
import { useActiveConnection } from '../state/ActiveConnectionContext.jsx';

function groupBySchema(tables) {
  const m = new Map();
  for (const t of tables) {
    const s = t.schema || 'public';
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(t);
  }
  return m;
}

export default function SchemaScreen() {
  const { active } = useActiveConnection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [fullSnapshot, setFullSnapshot] = useState(null);
  const [sourceMode, setSourceMode] = useState('db'); // db | json
  const [customJson, setCustomJson] = useState('');

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const schemas = useMemo(() => {
    const tables = snapshot?.tables || [];
    return Array.from(groupBySchema(tables).keys()).sort();
  }, [snapshot]);

  const [schemaFilter, setSchemaFilter] = useState('public');
  const [showViews, setShowViews] = useState(false);
  const [showEnums, setShowEnums] = useState(true);
  const [showFunctions, setShowFunctions] = useState(true);
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [hoveredTableId, setHoveredTableId] = useState(null);

  async function loadCustomSnapshotFromFile(file) {
    setError('');
    try {
      const text = await file.text();
      setCustomJson(text);
      setSourceMode('json');
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  const nodeTypes = useMemo(() => ({ table: TableNode }), []);

  async function autoLayout(nextNodes = nodes, nextEdges = edges) {
    if (!nextNodes.length) return;
    const pos = await computeElkLayout({
      nodes: nextNodes.map((n) => ({ id: n.id, width: 360, height: 320 })),
      edges: nextEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    });
    setNodes((curr) =>
      curr.map((n) => {
        const p = pos.get(n.id);
        if (!p) return n;
        return { ...n, position: { x: p.x, y: p.y } };
      })
    );
  }

  function applySnapshotToGraph(snap) {
    if (!snap) return;

    const tables = (snap.tables || []).filter((t) => {
      const schemaOk = !schemaFilter || schemaFilter === '__all__' ? true : t.schema === schemaFilter;
      const kindOk = showViews ? true : t.relkind === 'r' || t.relkind === 'p' || t.relkind === 'f';
      return schemaOk && kindOk;
    });

    const cols = snap.columns || [];
    const fks = snap.foreignKeys || [];

    const columnsByTableId = new Map();
    for (const c of cols) {
      if (!columnsByTableId.has(c.tableId)) columnsByTableId.set(c.tableId, []);
      columnsByTableId.get(c.tableId).push(c);
    }
    for (const [k, list] of columnsByTableId) list.sort((a, b) => (a.attnum || 0) - (b.attnum || 0));

    const fkColsByTableId = new Map();
    for (const fk of fks) {
      if (!fk?.fromTableId) continue;
      if (!fkColsByTableId.has(fk.fromTableId)) fkColsByTableId.set(fk.fromTableId, new Set());
      for (const col of fk.fromColumns || []) fkColsByTableId.get(fk.fromTableId).add(col);
    }

    const indexedColsByTableId = new Map();
    for (const t of snap.tables || []) {
      indexedColsByTableId.set(t.id, new Set(t.indexedColumns || []));
    }

    setNodes(
      tables.map((t, idx) => ({
        id: t.id,
        type: 'table',
        position: { x: (idx % 4) * 420, y: Math.floor(idx / 4) * 420 },
        data: {
          table: t,
          columns: columnsByTableId.get(t.id) || [],
          fkColumns: fkColsByTableId.get(t.id) || new Set(),
          indexedColumns: indexedColsByTableId.get(t.id) || new Set(),
          onSelect: (id) => setSelectedTableId(id),
          onHover: (id) => setHoveredTableId(id),
          selected: selectedTableId === t.id,
          dimmed: selectedTableId ? selectedTableId !== t.id : false,
          highlight: false,
        },
      }))
    );

    setEdges(
      fks
        .filter((fk) => fk.toTableId)
        .filter((fk) => {
          if (schemaFilter === '__all__') return true;
          if (!schemaFilter) return true;
          return fk.fromTableId?.startsWith(schemaFilter + '.') || fk.toTableId?.startsWith(schemaFilter + '.');
        })
        .map((fk) => ({
          id: fk.id,
          source: fk.fromTableId,
          target: fk.toTableId,
          label: fk.name,
          type: 'smoothstep',
          style: { stroke: 'rgba(255,255,255,0.25)' },
          labelStyle: { fill: 'rgba(238,242,255,0.6)', fontSize: 10 },
        }))
    );

    setSnapshot(snap);
  }

  async function loadSchema() {
    setError('');
    setLoading(true);
    try {
      if (sourceMode === 'json') {
        const parsed = JSON.parse(customJson || 'null');
        if (!parsed) throw new Error('Missing/invalid JSON snapshot');
        setFullSnapshot(parsed);
        applySnapshotToGraph(parsed);
      } else {
        const resp = await api('/api/schema/snapshot', {
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            connectionString: active.connectionString || '',
            pooler: active.connectionString ? undefined : active.pooler,
            options: {
              schemaInclude: schemaFilter === '__all__' ? '' : schemaFilter,
            },
            persist: false,
          },
        });

        setFullSnapshot(resp.snapshot);
        applySnapshotToGraph(resp.snapshot);
      }

      // Decongest immediately after loading.
      const snap = sourceMode === 'json' ? JSON.parse(customJson || 'null') : fullSnapshot;
      if (snap) {
        await autoLayout(
          (snap?.tables || []).map((t) => ({ id: t.id })),
          (snap?.foreignKeys || []).filter((fk) => fk.toTableId).map((fk) => ({ id: fk.id, source: fk.fromTableId, target: fk.toTableId }))
        );
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  // When filters/toggles change, re-filter locally (no DB hit).
  useEffect(() => {
    if (!fullSnapshot) return;
    applySnapshotToGraph(fullSnapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaFilter, showViews, showEnums, showFunctions]);

  const derived = useMemo(() => {
    const snap = snapshot;
    const tables = Array.isArray(snap?.tables) ? snap.tables : [];
    const columns = Array.isArray(snap?.columns) ? snap.columns : [];
    const fks = Array.isArray(snap?.foreignKeys) ? snap.foreignKeys : [];
    const indexes = Array.isArray(snap?.indexes) ? snap.indexes : [];

    const tableById = new Map(tables.map((t) => [t.id, t]));

    const columnsByTableId = new Map();
    for (const c of columns) {
      if (!columnsByTableId.has(c.tableId)) columnsByTableId.set(c.tableId, []);
      columnsByTableId.get(c.tableId).push(c);
    }
    for (const [k, list] of columnsByTableId) list.sort((a, b) => (a.attnum || 0) - (b.attnum || 0));

    const outgoingByTableId = new Map();
    const incomingByTableId = new Map();
    for (const fk of fks) {
      if (!fk?.fromTableId || !fk?.toTableId) continue;
      if (!outgoingByTableId.has(fk.fromTableId)) outgoingByTableId.set(fk.fromTableId, []);
      outgoingByTableId.get(fk.fromTableId).push(fk);
      if (!incomingByTableId.has(fk.toTableId)) incomingByTableId.set(fk.toTableId, []);
      incomingByTableId.get(fk.toTableId).push(fk);
    }

    const indexesByTableId = new Map();
    for (const idx of indexes) {
      if (!indexesByTableId.has(idx.tableId)) indexesByTableId.set(idx.tableId, []);
      indexesByTableId.get(idx.tableId).push(idx);
    }

    const neighbors = new Map();
    for (const fk of fks) {
      if (!fk?.fromTableId || !fk?.toTableId) continue;
      if (!neighbors.has(fk.fromTableId)) neighbors.set(fk.fromTableId, new Set());
      if (!neighbors.has(fk.toTableId)) neighbors.set(fk.toTableId, new Set());
      neighbors.get(fk.fromTableId).add(fk.toTableId);
      neighbors.get(fk.toTableId).add(fk.fromTableId);
    }

    return {
      tableById,
      columnsByTableId,
      outgoingByTableId,
      incomingByTableId,
      indexesByTableId,
      neighbors,
    };
  }, [snapshot]);

  const focusId = hoveredTableId || selectedTableId;

  const decoratedNodes = useMemo(() => {
    if (!focusId) return nodes;
    const neighborSet = derived.neighbors.get(focusId) || new Set();
    const allow = new Set([focusId, ...Array.from(neighborSet)]);
    return nodes.map((n) => {
      const dim = !allow.has(n.id);
      const hl = n.id === focusId || neighborSet.has(n.id);
      return {
        ...n,
        data: {
          ...n.data,
          dimmed: dim,
          highlight: hl,
          selected: selectedTableId === n.id,
        },
      };
    });
  }, [nodes, focusId, derived.neighbors, selectedTableId]);

  const decoratedEdges = useMemo(() => {
    if (!focusId) return edges;
    return edges.map((e) => {
      const connected = e.source === focusId || e.target === focusId;
      return {
        ...e,
        style: { stroke: connected ? 'rgba(59,130,246,0.65)' : 'rgba(255,255,255,0.10)', strokeWidth: connected ? 2 : 1 },
        labelStyle: { fill: connected ? 'rgba(238,242,255,0.75)' : 'rgba(238,242,255,0.35)', fontSize: 10 },
      };
    });
  }, [edges, focusId]);

  return (
    <div className="grid" style={{ gridTemplateColumns: '380px 1fr', alignItems: 'stretch' }}>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0 }}>Schema visualizer</h3>
        <div className="hint">
          Loads schema metadata from PostgreSQL catalogs. No manual JSON input. Default is clean: tables + FK relations.
        </div>

        <div className="toolbar" style={{ justifyContent: 'flex-start' }}>
          <button className="tab" style={{ border: '1px solid rgba(255,255,255,0.12)' }} onClick={loadSchema} disabled={loading}>
            {loading ? 'Loading…' : 'Load schema'}
          </button>

          <button
            className="tab"
            style={{ border: '1px solid rgba(255,255,255,0.12)' }}
            onClick={() => autoLayout()}
            disabled={loading || nodes.length === 0}
          >
            Auto-layout
          </button>
        </div>

        <div className="divider" />

        <div className="hint" style={{ fontWeight: 800 }}>Source</div>
        <div className="form-grid">
          <label className="check" style={{ gridColumn: '1 / -1' }}>
            <input type="radio" name="schemaSource" checked={sourceMode === 'db'} onChange={() => setSourceMode('db')} />
            <span className="field-label" style={{ margin: 0 }}>Active connection (from Run tab)</span>
          </label>
          <label className="check" style={{ gridColumn: '1 / -1' }}>
            <input type="radio" name="schemaSource" checked={sourceMode === 'json'} onChange={() => setSourceMode('json')} />
            <span className="field-label" style={{ margin: 0 }}>Custom snapshot JSON</span>
          </label>

          {sourceMode === 'db' ? (
            <div className="field full">
              <div className="field-hint">
                Using: <span className="mono">{active.connectionString ? 'connectionString' : `${active.pooler?.host || 'pooler'}:${active.pooler?.port || 5432}`}</span>
              </div>
            </div>
          ) : (
            <>
              <div className="field full">
                <div className="field-label">Snapshot JSON</div>
                <textarea value={customJson} onChange={(e) => setCustomJson(e.target.value)} placeholder="Paste /api/schema/snapshot response.snapshot JSON here…" style={{ minHeight: 140 }} />
                <div className="field-hint">Tip: You can fetch a snapshot via API or reuse a previously persisted snapshot file.</div>
              </div>
              <div className="toolbar">
                <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
                  Upload JSON
                  <input
                    type="file"
                    accept="application/json"
                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void loadCustomSnapshotFromFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </>
          )}
        </div>

        <div className="hint">Schema filter</div>
        <div className="field full">
          <div className="field-label">Schema</div>
          <select value={schemaFilter} onChange={(e) => setSchemaFilter(e.target.value)}>
            <option value="__all__">All schemas</option>
            <option value="public">public</option>
            {schemas
              .filter((s) => s !== 'public')
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
        </div>

        <div className="divider" />

        <div className="hint" style={{ fontWeight: 800 }}>Advanced</div>
        <label className="check">
          <input type="checkbox" checked={showViews} onChange={(e) => setShowViews(e.target.checked)} />
          <span className="field-label" style={{ margin: 0 }}>Show views / materialized views</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={showEnums} onChange={(e) => setShowEnums(e.target.checked)} />
          <span className="field-label" style={{ margin: 0 }}>Show enums (sidebar)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={showFunctions} onChange={(e) => setShowFunctions(e.target.checked)} />
          <span className="field-label" style={{ margin: 0 }}>Show functions (sidebar)</span>
        </label>

        {error ? (
          <div className="alert warn">
            <div style={{ fontWeight: 800 }}>Schema load failed</div>
            <div className="hint" style={{ marginTop: 6 }}>
              {error}
            </div>
          </div>
        ) : null}

        <div className="divider" />

        <div className="hint" style={{ marginTop: 6 }}>
          Details
        </div>
        <div className="card" style={{ padding: 12, height: 420, overflow: 'auto' }}>
          {loading ? (
            <div className="hint">Loading…</div>
          ) : !selectedTableId ? (
            <div className="hint">Click a table card to see details.</div>
          ) : (
            (() => {
              const t = derived.tableById.get(selectedTableId);
              if (!t) return <div className="hint">Unknown table: {selectedTableId}</div>;
              const cols = derived.columnsByTableId.get(selectedTableId) || [];
              const outFks = derived.outgoingByTableId.get(selectedTableId) || [];
              const inFks = derived.incomingByTableId.get(selectedTableId) || [];
              const idxs = derived.indexesByTableId.get(selectedTableId) || [];
              const rls = t.rls;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>{t.schema}.{t.name}</div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      Columns: {cols.length} • PK: {t.primaryKeyColumns?.length ? t.primaryKeyColumns.join(', ') : '—'}
                    </div>
                  </div>

                  <div className="hint" style={{ fontWeight: 800 }}>Foreign keys (outgoing)</div>
                  {outFks.length ? (
                    <div className="mono">
                      {outFks.map((fk) => (
                        <div key={fk.id} style={{ marginBottom: 8 }}>
                          {fk.name}
                          {'\n'}({(fk.fromColumns || []).join(', ')}) → {fk.toTableId}({(fk.toColumns || []).join(', ')})
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hint">—</div>
                  )}

                  <div className="hint" style={{ fontWeight: 800 }}>Foreign keys (incoming)</div>
                  {inFks.length ? (
                    <div className="mono">
                      {inFks.map((fk) => (
                        <div key={fk.id} style={{ marginBottom: 8 }}>
                          {fk.fromTableId} → ({(fk.fromColumns || []).join(', ')})
                          {'\n'}{fk.name}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hint">—</div>
                  )}

                  <div className="hint" style={{ fontWeight: 800 }}>Indexes</div>
                  {idxs.length ? (
                    <div className="mono">
                      {idxs.map((i) => (
                        <div key={i.name} style={{ marginBottom: 8 }}>
                          {i.name}{i.isPrimary ? ' [PK]' : ''}{i.isUnique ? ' [UNIQUE]' : ''}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hint">—</div>
                  )}

                  <div className="hint" style={{ fontWeight: 800 }}>RLS</div>
                  <div className="mono">
                    enabled: {rls?.enabled ? 'true' : 'false'}{'\n'}forced: {rls?.forced ? 'true' : 'false'}
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {((showEnums && snapshot?.enums?.length) || (showFunctions && snapshot?.functions?.length)) ? <div className="divider" /> : null}

        {showEnums && snapshot?.enums?.length ? (
          <>
            <div className="hint" style={{ fontWeight: 800 }}>Enums</div>
            <div className="mono" style={{ maxHeight: 140, overflow: 'auto' }}>
              {snapshot.enums.map((e) => (
                <div key={`${e.schema}.${e.name}`}>{e.schema}.{e.name}</div>
              ))}
            </div>
          </>
        ) : null}

        {showFunctions && snapshot?.functions?.length ? (
          <>
            <div className="hint" style={{ fontWeight: 800, marginTop: 6 }}>Functions</div>
            <div className="mono" style={{ maxHeight: 140, overflow: 'auto' }}>
              {snapshot.functions.slice(0, 80).map((f) => (
                <div key={`${f.schema}.${f.name}`}>{f.schema}.{f.name}</div>
              ))}
              {snapshot.functions.length > 80 ? <div className="hint">+ {snapshot.functions.length - 80} more…</div> : null}
            </div>
          </>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', height: '72vh' }}>
        <ReactFlow
          nodes={decoratedNodes}
          edges={decoratedEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Background gap={18} size={1} color="rgba(255,255,255,0.06)" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
