import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  getNodesBounds,
  getTransformForBounds,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';

import * as htmlToImage from 'html-to-image';
import jsPDF from 'jspdf';

import { api } from '../lib/http.js';
import TableNode from '../schema/nodes/TableNode.jsx';
import FkEdge from '../schema/edges/FkEdge.jsx';
import {
  chooseLayoutMode,
  computeElkPositions,
  computeGridPositions,
  styleModeFor,
} from '../schema/layout/layoutEngine.js';
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
  const { active, setActive } = useActiveConnection();
  const rf = useReactFlow();
  const fitTimerRef = useRef(null);
  const pendingFitRef = useRef(false);
  const pendingFitReasonRef = useRef('');
  const activeLayoutJobRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [layouting, setLayouting] = useState(false);
  const [layoutNote, setLayoutNote] = useState('');
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [fullSnapshot, setFullSnapshot] = useState(null);
  const [sourceMode, setSourceMode] = useState('db'); // db | json
  const [customJson, setCustomJson] = useState('');

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [edgeStyleMode, setEdgeStyleMode] = useState('full'); // full | perf

  const [exportFormat, setExportFormat] = useState('png'); // png | jpg | pdf
  const [exportScope, setExportScope] = useState('viewport'); // viewport | entire
  const [exportScale, setExportScale] = useState(3);

  const schemas = useMemo(() => {
    const tables = snapshot?.tables || [];
    return Array.from(groupBySchema(tables).keys()).sort();
  }, [snapshot]);

  const [schemaFilter, setSchemaFilter] = useState('__all__');
  const [showViews, setShowViews] = useState(false);
  const [showEnums, setShowEnums] = useState(true);
  const [showFunctions, setShowFunctions] = useState(true);
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [hoveredTableId, setHoveredTableId] = useState(null);
  const [schemaPassword, setSchemaPassword] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [dbSchemas, setDbSchemas] = useState([]);

  // Enums/Functions expand/collapse state
  const [enumsExpanded, setEnumsExpanded] = useState(false);
  const [functionsExpanded, setFunctionsExpanded] = useState(false);

  // Only show MiniMap when diagram is larger than viewport.
  const [showMiniMap, setShowMiniMap] = useState(false);
  // Fit-to-view should only happen after nodes are committed into ReactFlow.
  // We coordinate it via pendingFitRef + a useEffect on `nodes`.
  const requestFitView = useCallback((reason = '') => {
    pendingFitRef.current = true;
    pendingFitReasonRef.current = reason;
  }, []);

  const updateMiniMapVisibility = useCallback(
    (nextNodes) => {
      try {
        const list = Array.isArray(nextNodes) ? nextNodes : rf.getNodes();
        if (!list?.length) return setShowMiniMap(false);

        const flowEl = document.querySelector('.react-flow');
        if (!flowEl) return;

        const vb = { w: flowEl.clientWidth || 0, h: flowEl.clientHeight || 0 };
        if (!vb.w || !vb.h) return;

        const bounds = getNodesBounds(list);
        const needs = bounds.width > vb.w * 0.98 || bounds.height > vb.h * 0.98;
        setShowMiniMap(needs);
      } catch {
        // ignore
      }
    },
    [rf]
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem('pgbackup.profiles');
      const parsed = raw ? JSON.parse(raw) : [];
      setProfiles(Array.isArray(parsed) ? parsed : []);
    } catch {
      setProfiles([]);
    }
  }, []);

  // Fetch schemas list from DB so dropdown can show all schemas present.
  useEffect(() => {
    if (sourceMode !== 'db') return;
    if (active.connectionString) {
      // connection string mode should work without password
    } else {
      // pooler mode needs password
      const pw = active.pooler?.password || schemaPassword;
      if (!pw) return;
    }

    (async () => {
      try {
        const resp = await api('/api/schema/list-schemas', {
          method: 'POST',
          timeoutMs: 30_000,
          body: {
            connectionString: active.connectionString || '',
            pooler: active.connectionString ? undefined : { ...(active.pooler || {}), password: active.pooler?.password || schemaPassword || '' },
            options: {},
            persist: false,
          },
        });

        const list = Array.isArray(resp.schemas) ? resp.schemas : [];
        setDbSchemas(list);
      } catch {
        // ignore: schema snapshot load will still populate the dropdown later
      }
    })();
  }, [sourceMode, active.connectionString, active.pooler?.host, active.pooler?.port, active.pooler?.user, active.pooler?.database, active.pooler?.password, schemaPassword]);

  function applyProfile(p) {
    if (!p) return;
    setActive((curr) => ({
      ...curr,
      connectionString: p.connectionString || '',
      pooler: {
        ...(curr.pooler || {}),
        host: p.host || curr.pooler?.host,
        port: Number(p.port || curr.pooler?.port || 5432),
        user: p.user || curr.pooler?.user,
        database: p.database || curr.pooler?.database,
        // keep current password (never stored)
        password: curr.pooler?.password || schemaPassword || '',
      },
    }));
  }

  function onSelectProfile(id) {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    applyProfile(p);
  }

  // Allow entering password here to avoid a dead-end when Schema is opened first.
  useEffect(() => {
    if (!schemaPassword) return;
    setActive((curr) => ({
      ...curr,
      pooler: { ...(curr.pooler || {}), password: schemaPassword },
    }));
  }, [schemaPassword, setActive]);

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
  const edgeTypes = useMemo(() => ({ fk: FkEdge }), []);

  function simplifyEdgesForPerf(nextEdges) {
    return (nextEdges || []).map((e) => ({
      ...e,
      style: { ...(e.style || {}), stroke: 'rgba(148,163,184,0.28)', strokeWidth: 1.5 },
      labelStyle: { ...(e.labelStyle || {}), fill: 'rgba(226,232,240,0.35)', fontSize: 9, fontWeight: 700 },
      interactionWidth: 10,
    }));
  }

  async function applyProgressiveLayout({ nextNodes, nextEdges, cacheKey, fit = true }) {
    const safeNodes = Array.isArray(nextNodes) ? nextNodes : [];
    const safeEdges = Array.isArray(nextEdges) ? nextEdges : [];

    // Cancel prior jobs by incrementing job id
    const jobId = ++activeLayoutJobRef.current;

    if (!safeNodes.length) {
      setNodes([]);
      setEdges([]);
      setShowMiniMap(false);
      setLayoutNote('');
      return;
    }

    // Phase 1: instant grid
    const mode = chooseLayoutMode(safeNodes.length);
    setEdgeStyleMode(styleModeFor(safeNodes.length));
    const gridNodes = computeGridPositions(safeNodes);
    const gridEdges = mode === 'perf' ? simplifyEdgesForPerf(safeEdges) : safeEdges;

    setLayouting(false);
    setLayoutNote(mode === 'search' ? 'Large schema: use search/focus (not implemented yet)' : '');
    setEdges(gridEdges);
    setNodes(gridNodes);
    if (fit) requestFitView('grid');

    // Phase 2: worker ELK (best-effort, strictly time-budgeted)
    // If it can't finish quickly, we keep the fast grid layout.
    if (mode === 'search') return;

    const tooBig = safeNodes.length > 180 || safeEdges.length > 420;
    if (tooBig) {
      setLayouting(false);
      setLayoutNote('Fast layout');
      return;
    }

    // Never block the UI. No overlay for refinement.
    setLayouting(false);
    setLayoutNote('Fast layout');

    const budgetMs = mode === 'perf' ? 800 : 600;

    try {
      const elkPromise = computeElkPositions({
        cacheKey,
        mode: mode === 'perf' ? 'perf' : 'full',
        nodes: safeNodes,
        edges: safeEdges,
      });

      const budgetPromise = new Promise((_, reject) =>
        window.setTimeout(() => reject(Object.assign(new Error('LAYOUT_BUDGET_EXCEEDED'), { code: 'LAYOUT_BUDGET_EXCEEDED' })), budgetMs)
      );

      const { positions, cached, ms } = await Promise.race([elkPromise, budgetPromise]);

      // Ignore stale worker results
      if (activeLayoutJobRef.current !== jobId) return;

      const laidOutNodes = gridNodes.map((n) => {
        const p = positions[n.id];
        return p ? { ...n, position: { x: p.x, y: p.y } } : n;
      });

      const finalEdges = mode === 'perf' ? simplifyEdgesForPerf(safeEdges) : safeEdges;
      setEdges(finalEdges);
      setNodes(laidOutNodes);
      setLayouting(false);
      setLayoutNote(cached ? '' : '');

      if (fit) requestFitView('elk');
    } catch (e) {
      if (activeLayoutJobRef.current !== jobId) return;
      setLayouting(false);
      // Budget exceeded is expected in "instant always" mode.
      if (e?.code === 'LAYOUT_BUDGET_EXCEEDED' || e?.message === 'LAYOUT_BUDGET_EXCEEDED') {
        setLayoutNote('Fast layout');
        return;
      }

      setLayoutNote('Fast layout');
      // Keep grid layout; surface real errors.
      setError((curr) => curr || (e?.message || String(e)));
    }
  }

  async function exportDiagram() {
    const el = document.querySelector('.react-flow');
    if (!el) return;

    // Default: export visible viewport (what user sees after moving blocks).
    // Optionally: export entire graph by temporarily fitting all nodes.
    const instance = window.__rfInstance;
    const prevViewport = instance?.getViewport?.();
    const prevWidth = el.style.width;
    const prevHeight = el.style.height;

    try {
      if (exportScope === 'entire' && instance) {
        const nodes = instance.getNodes();
        const bounds = getNodesBounds(nodes);

        // Compute export canvas size based on node bounds (diagram coords) and desired padding.
        const padding = 36;
        const width = Math.max(1, Math.ceil(bounds.width + padding * 2));
        const height = Math.max(1, Math.ceil(bounds.height + padding * 2));

        // Temporarily resize the react-flow viewport so html-to-image captures the full diagram.
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;

        const { x, y, zoom } = getTransformForBounds(bounds, width, height, 0.15, 2);
        instance.setViewport({ x, y, zoom }, { duration: 0 });
      }

      const toDataUrl = exportFormat === 'jpg' ? htmlToImage.toJpeg : htmlToImage.toPng;
      const dataUrl = await toDataUrl(el, {
        pixelRatio: exportScale,
        backgroundColor: '#0b0d12',
        filter: (node) => {
          // Exclude UI chrome inside diagram.
          const cls = node?.classList;
          if (!cls) return true;
          if (cls.contains('react-flow__minimap')) return false;
          if (cls.contains('react-flow__controls')) return false;
          return true;
        },
      });

      if (exportFormat === 'pdf') {
        // Create a PDF sized to the exported image (high quality single-page).
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = dataUrl;
        });

        const pdf = new jsPDF({ orientation: img.width >= img.height ? 'landscape' : 'portrait', unit: 'px', format: [img.width, img.height] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
        pdf.save('schema.pdf');
      } else {
        const a = document.createElement('a');
        a.download = `schema.${exportFormat}`;
        a.href = dataUrl;
        a.click();
      }
    } finally {
      // Restore viewport + size.
      if (exportScope === 'entire') {
        el.style.width = prevWidth;
        el.style.height = prevHeight;
        if (instance && prevViewport) instance.setViewport(prevViewport, { duration: 0 });
      }
    }
  }

  async function applySnapshotToGraph(snap, { fit = true } = {}) {
    if (!snap) return;

    // Clear selection if the selected table no longer exists after schema changes.
    const nextTableIds = new Set((snap.tables || []).map((t) => t.id));
    setSelectedTableId((curr) => (curr && nextTableIds.has(curr) ? curr : null));

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

    const nextNodes = tables.map((t) => ({
      id: t.id,
      type: 'table',
      // Temporary position near origin; ELK will override.
      position: { x: 0, y: 0 },
      data: {
        table: t,
        columns: columnsByTableId.get(t.id) || [],
        fkColumns: fkColsByTableId.get(t.id) || new Set(),
        indexedColumns: indexedColsByTableId.get(t.id) || new Set(),
        // Selection is handled via ReactFlow `onNodeClick` (supports toggle).
        onSelect: undefined,
        onHover: (id) => setHoveredTableId(id),
        selected: selectedTableId === t.id,
        dimmed: selectedTableId ? selectedTableId !== t.id : false,
        highlight: false,
      },
    }));

    const nextEdges = fks
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
        type: 'fk',
        style: { stroke: 'rgba(94,234,212,0.55)', strokeWidth: 3 },
        labelStyle: { fill: 'rgba(238,242,255,0.85)', fontSize: 10, fontWeight: 800 },
        labelBgStyle: {
          fill: 'rgba(17, 24, 42, 0.92)',
          stroke: 'rgba(255,255,255,0.18)',
          strokeWidth: 1,
        },
        interactionWidth: 18,
        labelBgPadding: [6, 10],
        labelBgBorderRadius: 10,
        markerEnd: {
          type: 'arrowclosed',
          width: 16,
          height: 16,
          color: 'rgba(94,234,212,0.85)',
        },
        data: { label: fk.name },
      }));

    setSnapshot(snap);

    // Ensure viewport doesn't stay far away from origin if a prior fit went wrong.
    try {
      rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
    } catch {
      // ignore
    }

    const cacheKey = JSON.stringify({
      schema: schemaFilter,
      showViews,
      // bump if layout algo changes
      v: 1,
      nodeCount: nextNodes.length,
      edgeCount: nextEdges.length,
    });

    await applyProgressiveLayout({ nextNodes, nextEdges, cacheKey, fit });
  }

  async function loadSchema() {
    setError('');
    setLoading(true);
    try {
      if (sourceMode === 'json') {
        const parsed = JSON.parse(customJson || 'null');
        if (!parsed) throw new Error('Missing/invalid JSON snapshot');
        setFullSnapshot(parsed);
        await applySnapshotToGraph(parsed, { fit: true });
      } else {
        const resp = await api('/api/schema/snapshot', {
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            connectionString: active.connectionString || '',
            pooler: active.connectionString ? undefined : { ...(active.pooler || {}), password: (active.pooler?.password || schemaPassword || '') },
            options: {
              schemaInclude: schemaFilter === '__all__' ? '' : schemaFilter,
            },
            persist: false,
          },
        });

        setFullSnapshot(resp.snapshot);
        await applySnapshotToGraph(resp.snapshot, { fit: true });
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
    // On schema filter changes, we must immediately show nodes; always fit.
    void applySnapshotToGraph(fullSnapshot, { fit: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaFilter, showViews, showEnums, showFunctions]);

  // Perform pending fit-to-view after nodes are committed.
  useEffect(() => {
    if (!pendingFitRef.current) return;
    if (!nodes?.length) return;

    pendingFitRef.current = false;
    const reason = pendingFitReasonRef.current;
    pendingFitReasonRef.current = '';

    // Fit instantly first (guarantee visible), then optionally animate.
    try {
      rf.fitView({ nodes, padding: 0.2, duration: 0 });
      // A second pass after layout/measurement helps avoid rare empty fits.
      window.setTimeout(() => {
        try {
          rf.fitView({ nodes, padding: 0.2, duration: 220 });
        } catch {
          // ignore
        }
      }, 30);
    } catch {
      // ignore
    }

    updateMiniMapVisibility(nodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, rf]);

  // Update minimap visibility after manual zoom/pan.
  // (reactflow v11 triggers onMoveEnd after interactions)
  const onMoveEnd = useCallback(() => {
    updateMiniMapVisibility();
  }, [updateMiniMapVisibility]);

  // Cleanup delayed fit timers.
  useEffect(() => {
    return () => {
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    };
  }, []);

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

  // In performance mode we avoid the expensive FK edge label collision logic
  // (FkEdge does rf.getNodes() + geometry for every edge).
  // Instead, we downgrade edges to default to keep interactions smooth.
  const effectiveEdgeTypes = useMemo(() => {
    if (edgeStyleMode === 'perf') return {};
    return edgeTypes;
  }, [edgeStyleMode, edgeTypes]);

  return (
    <div className="schema-screen">
      <div className="schema-layout">
        <div className="card schema-left" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Heading + description */}
          <div className="section">
            <h3 style={{ margin: 0 }}>Schema visualizer</h3>
            <div className="hint">Loads schema metadata from PostgreSQL catalogs and renders tables + FK relations.</div>
          </div>

          {/* Source */}
          <div className="section">
            <div className="section-title">Source</div>
            <div className="seg" role="radiogroup" aria-label="Schema source">
              <label data-active={sourceMode === 'db'}>
                <input type="radio" name="schemaSource" checked={sourceMode === 'db'} onChange={() => setSourceMode('db')} />
                Active connection
              </label>
              <label data-active={sourceMode === 'json'}>
                <input type="radio" name="schemaSource" checked={sourceMode === 'json'} onChange={() => setSourceMode('json')} />
                Snapshot JSON
              </label>
            </div>

            {sourceMode === 'db' ? (
              <div className="field full" style={{ marginTop: 6 }}>
                <div className="field-hint">
                  Using:{' '}
                  <span className="mono">
                    {active.connectionString ? 'connectionString' : `${active.pooler?.host || 'pooler'}:${active.pooler?.port || 5432}`}
                  </span>
                </div>
              </div>
            ) : (
              <div className="form-grid schema-source-json" style={{ marginTop: 10 }}>
                <div className="field full">
                  <div className="field-label">Snapshot JSON</div>
                  <textarea
                    value={customJson}
                    onChange={(e) => setCustomJson(e.target.value)}
                    placeholder="Paste /api/schema/snapshot response.snapshot JSON here…"
                    style={{ minHeight: 140 }}
                  />
                  <div className="field-hint">Tip: You can fetch a snapshot via API or reuse a previously persisted snapshot file.</div>
                </div>
                <div className="field full">
                  <label className="btn" style={{ position: 'relative', overflow: 'hidden', width: 'fit-content' }}>
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
              </div>
            )}
          </div>

          {/* Connection */}
          {sourceMode === 'db' ? (
            <div className="section">
              <div className="section-title">Connection</div>

              <div className="form-grid">
                <div className="field full">
                  <div className="field-label">Profile</div>
                  <select value={profileId} onChange={(e) => onSelectProfile(e.target.value)}>
                    <option value="">— Select profile —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className="field-hint">Uses profiles from Run tab (stored in localStorage). Password is never stored.</div>
                </div>

                {!active.connectionString ? (
                  <div className="field full">
                    <div className="field-label">Pooler password</div>
                    <input
                      type="password"
                      value={schemaPassword}
                      onChange={(e) => setSchemaPassword(e.target.value)}
                      placeholder="Enter password to load schema…"
                    />
                    <div className="field-hint">Password is kept in memory only (not saved to disk / profiles).</div>
                  </div>
                ) : (
                  <div className="field full">
                    <div className="field-hint">Connection string is set; pooler password not needed.</div>
                  </div>
                )}
              </div>

              {!active.connectionString && !schemaPassword ? (
                <div className="alert warn" style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 800 }}>Pooler password required</div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    Enter the pooler password above (or paste a full connection string in Run, then return).
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Actions (after Connection; before Schema & advanced) */}
          {sourceMode === 'db' ? (
            <div className="section">
              <div className="section-title">Actions</div>
              <div className="toolbar" style={{ justifyContent: 'flex-start' }}>
                <button className="btn primary" type="button" onClick={loadSchema} disabled={loading}>
                  {loading ? 'Loading…' : 'Load schema'}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    const cacheKey = JSON.stringify({ schema: schemaFilter, showViews, v: 1, nodeCount: nodes.length, edgeCount: edges.length });
                    void applyProgressiveLayout({ nextNodes: nodes, nextEdges: edges, cacheKey, fit: true });
                  }}
                  disabled={loading || nodes.length === 0}
                >
                  Auto-layout
                </button>
              </div>
            </div>
          ) : null}

          {/* Schema + Advanced */}
          <div className="section">
            <div className="section-title">Schema & advanced</div>
            <div className="form-grid">
              <div className="field full">
                <div className="field-label">Schema</div>
                <select value={schemaFilter} onChange={(e) => setSchemaFilter(e.target.value)}>
                  <option value="__all__">All schemas</option>
                  <option value="public">public</option>
                  {(dbSchemas.length ? dbSchemas : schemas)
                    .filter((s) => s !== 'public')
                    .map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <label className="check">
              <input type="checkbox" checked={showViews} onChange={(e) => setShowViews(e.target.checked)} />
              <span className="field-label" style={{ margin: 0 }}>
                Show views / materialized views
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={showEnums} onChange={(e) => setShowEnums(e.target.checked)} />
              <span className="field-label" style={{ margin: 0 }}>
                Show enums (sidebar)
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={showFunctions} onChange={(e) => setShowFunctions(e.target.checked)} />
              <span className="field-label" style={{ margin: 0 }}>
                Show functions (sidebar)
              </span>
            </label>
          </div>

          {/* Export */}
          <div className="section">
            <div className="section-title">Export</div>
            <div className="form-grid">
              <div className="field full">
                <button className="btn" type="button" onClick={exportDiagram} disabled={nodes.length === 0}>
                  Export
                </button>
                <div className="field-hint" style={{ marginTop: 6 }}>
                  Tip: choose “Entire diagram” to export all nodes (it temporarily resizes the viewport to capture everything).
                </div>
              </div>
              <div className="field">
                <div className="field-label">Format</div>
                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
                  <option value="png">PNG</option>
                  <option value="jpg">JPG</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>
              <div className="field">
                <div className="field-label">Scope</div>
                <select value={exportScope} onChange={(e) => setExportScope(e.target.value)}>
                  <option value="viewport">Visible viewport</option>
                  <option value="entire">Entire diagram</option>
                </select>
              </div>
              <div className="field">
                <div className="field-label">Scale</div>
                <select value={exportScale} onChange={(e) => setExportScale(Number(e.target.value))}>
                  <option value={2}>2x</option>
                  <option value={3}>3x</option>
                  <option value={4}>4x</option>
                </select>
              </div>
            </div>
          </div>

          {error ? (
            <div className="alert warn">
              <div style={{ fontWeight: 800 }}>Schema load failed</div>
              <div className="hint" style={{ marginTop: 6 }}>
                {error}
              </div>
            </div>
          ) : null}

          {/* Details */}
          <div className="section">
            <div className="section-title">Details</div>
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
          </div>

          {/* Enums + Functions */}
          {showEnums && snapshot?.enums?.length ? (
            <div className="section">
              <div className="section-title">Enums</div>
              <div className="card" style={{ padding: 10 }}>
                {(() => {
                  const list = snapshot.enums || [];
                  const LIMIT = 5;
                  const show = enumsExpanded ? list : list.slice(0, LIMIT);
                  const more = Math.max(0, list.length - show.length);
                  return (
                    <>
                      <div className="schema-table-scroll">
                        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: 8, color: 'rgba(238,242,255,0.65)' }}>Schema</th>
                              <th style={{ textAlign: 'left', padding: 8, color: 'rgba(238,242,255,0.65)' }}>Name</th>
                            </tr>
                          </thead>
                          <tbody>
                            {show.map((e) => (
                              <tr key={`${e.schema}.${e.name}`}>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                  {e.schema}
                                </td>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                  {e.name}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {more > 0 ? (
                        <button className="btn" type="button" style={{ marginTop: 10, width: '100%' }} onClick={() => setEnumsExpanded(true)}>
                          + {more} more…
                        </button>
                      ) : null}

                      {enumsExpanded && list.length > LIMIT ? (
                        <button className="btn" type="button" style={{ marginTop: 10, width: '100%' }} onClick={() => setEnumsExpanded(false)}>
                          Collapse
                        </button>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
          ) : null}

          {showFunctions && snapshot?.functions?.length ? (
            <div className="section">
              <div className="section-title">Functions</div>
              <div className="card" style={{ padding: 10 }}>
                {(() => {
                  const list = snapshot.functions || [];
                  const LIMIT = 5;
                  const show = functionsExpanded ? list : list.slice(0, LIMIT);
                  const more = Math.max(0, list.length - show.length);
                  return (
                    <>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {functionsExpanded ? `Showing ${list.length} functions` : `Showing first ${show.length} functions`}
                      </div>

                      <div className="schema-table-scroll">
                        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: 8, color: 'rgba(238,242,255,0.65)' }}>Schema</th>
                              <th style={{ textAlign: 'left', padding: 8, color: 'rgba(238,242,255,0.65)' }}>Name</th>
                            </tr>
                          </thead>
                          <tbody>
                            {show.map((f) => (
                              <tr key={`${f.schema}.${f.name}`}>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                  {f.schema}
                                </td>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                  {f.name}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {more > 0 ? (
                        <button className="btn" type="button" style={{ marginTop: 10, width: '100%' }} onClick={() => setFunctionsExpanded(true)}>
                          + {more} more…
                        </button>
                      ) : null}

                      {functionsExpanded && list.length > LIMIT ? (
                        <button className="btn" type="button" style={{ marginTop: 10, width: '100%' }} onClick={() => setFunctionsExpanded(false)}>
                          Collapse
                        </button>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
          ) : null}
        </div>

        <div className="card schema-right" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="schema-flow">
            {nodes.length === 0 ? (
              <div className="schema-flow-overlay">
                <div className="schema-flow-overlay__card">No tables to display for this schema/filter.</div>
              </div>
            ) : null}

            <ReactFlow
              nodes={decoratedNodes}
              edges={decoratedEdges}
              nodeTypes={nodeTypes}
              edgeTypes={effectiveEdgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onMoveEnd={onMoveEnd}
              onPaneClick={() => {
                setSelectedTableId(null);
                setHoveredTableId(null);
              }}
              onNodeClick={(_, node) => {
                // Toggle selection on second click.
                setSelectedTableId((curr) => (curr === node.id ? null : node.id));
              }}
              onInit={(inst) => {
                window.__rfInstance = inst;
              }}
              fitView
            >
              <Background gap={18} size={1} color="rgba(255,255,255,0.06)" />
              <Controls />
              {showMiniMap ? <MiniMap pannable zoomable /> : null}
            </ReactFlow>

            {layoutNote && nodes.length ? (
              <div style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 30 }}>
                <div className="schema-flow-overlay__card" style={{ background: 'rgba(17, 24, 42, 0.72)' }}>{layoutNote}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// React Flow hooks (useReactFlow/useNodesState/etc.) rely on an internal zustand store.
// When used outside of <ReactFlowProvider>, React Flow throws:
// "Seems like you have not used zustand provider as an ancestor".
// We wrap the screen so the provider always exists.
export function SchemaScreenWithProvider() {
  return (
    <ReactFlowProvider>
      <SchemaScreen />
    </ReactFlowProvider>
  );
}
