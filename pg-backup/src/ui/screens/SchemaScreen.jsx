import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getTransformForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';

import * as htmlToImage from 'html-to-image';
import jsPDF from 'jspdf';

import { api } from '../lib/http.js';
import { getStorageKey } from '../lib/runtime.js';
import FkEdge from '../schema/edges/FkEdge.jsx';
import { chooseLayoutMode, computeElkPositions, computeGridPositions, styleModeFor } from '../schema/layout/layoutEngine.js';
import TableNode from '../schema/nodes/TableNode.jsx';
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

function normalizeNodePositions(list, { margin = 8 } = {}) {
  const nodes = Array.isArray(list) ? list : [];
  if (!nodes.length) return nodes;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    const x = Number(n?.position?.x || 0);
    const y = Number(n?.position?.y || 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }

  const shiftX = margin - minX;
  const shiftY = margin - minY;
  if (!shiftX && !shiftY) return nodes;

  return nodes.map((n) => ({
    ...n,
    position: {
      x: Number(n?.position?.x || 0) + shiftX,
      y: Number(n?.position?.y || 0) + shiftY,
    },
  }));
}

export default function SchemaScreen() {
  const { active, setActive } = useActiveConnection();
  const rf = useReactFlow();
  const fitTimerRef = useRef(null);
  const flowViewportRef = useRef(null);
  const pendingFitRef = useRef(false);
  const pendingFitReasonRef = useRef('');
  const activeLayoutJobRef = useRef(0);

  const [loading, setLoading] = useState(false);
  const [layouting, setLayouting] = useState(false);
  const [layoutNote, setLayoutNote] = useState('');
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [fullSnapshot, setFullSnapshot] = useState(null);
  const [sourceMode, setSourceMode] = useState('db');
  const [customJson, setCustomJson] = useState('');

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [edgeStyleMode, setEdgeStyleMode] = useState('full');
  const [exportFormat, setExportFormat] = useState('png');
  const [exportScope, setExportScope] = useState('viewport');
  const [exportScale, setExportScale] = useState(3);

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
  const [profilesJson, setProfilesJson] = useState('');
  const [enumsExpanded, setEnumsExpanded] = useState(false);
  const [functionsExpanded, setFunctionsExpanded] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [flowViewportSize, setFlowViewportSize] = useState({ w: 0, h: 0 });
  const [minZoomLevel, setMinZoomLevel] = useState(0.1);
  const [translateExtent, setTranslateExtent] = useState([[-100000, -100000], [100000, 100000]]);

  const schemas = useMemo(() => {
    const tables = snapshot?.tables || [];
    return Array.from(groupBySchema(tables).keys()).sort();
  }, [snapshot]);

  const requestFitView = useCallback((reason = '') => {
    pendingFitRef.current = true;
    pendingFitReasonRef.current = reason;
  }, []);

  const updateMiniMapVisibility = useCallback(
    (nextNodes) => {
      try {
        const list = Array.isArray(nextNodes) ? nextNodes : rf.getNodes();
        if (!list?.length) return setShowMiniMap(false);

        const flowEl = flowViewportRef.current || document.querySelector('.react-flow');
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
    (async () => {
      try {
        const raw = localStorage.getItem(getStorageKey('profiles'));
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed.length) {
          setProfiles(parsed);
          return;
        }
      } catch {
        // ignore
      }

      try {
        const resp = await api('/profiles-template');
        setProfiles(Array.isArray(resp.profiles) ? resp.profiles : []);
      } catch {
        setProfiles([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (sourceMode !== 'db') return;
    if (!active.connectionString) {
      const pw = active.pooler?.password || schemaPassword;
      if (!pw) return;
    }

    (async () => {
      try {
        const resp = await api('/schema/list-schemas', {
          method: 'POST',
          timeoutMs: 30_000,
          body: {
            connectionString: active.connectionString || '',
            pooler: active.connectionString
              ? undefined
              : { ...(active.pooler || {}), password: active.pooler?.password || schemaPassword || '' },
            options: {},
            persist: false,
          },
        });

        setDbSchemas(Array.isArray(resp.schemas) ? resp.schemas : []);
      } catch {
        // ignore
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
        password: curr.pooler?.password || schemaPassword || '',
      },
    }));
  }

  function onSelectProfile(id) {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    applyProfile(p);
  }

  function normalizeProfiles(input) {
    if (!Array.isArray(input)) throw new Error('Profiles JSON must be an array');
    return input
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id || `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`),
        name: String(p.name || 'Unnamed profile'),
        host: p.host ? String(p.host) : '',
        port: p.port != null ? Number(p.port) : 5432,
        user: p.user ? String(p.user) : '',
        database: p.database ? String(p.database) : '',
        connectionString: p.connectionString ? String(p.connectionString) : '',
        createdAt: p.createdAt ? String(p.createdAt) : new Date().toISOString(),
      }))
      .slice(0, 50);
  }

  function loadProfilesFromJsonTextAndApplyFirst() {
    setError('');
    try {
      const parsed = JSON.parse(profilesJson || '[]');
      const next = normalizeProfiles(parsed);
      localStorage.setItem(getStorageKey('profiles'), JSON.stringify(next));
      setProfiles(next);

      const first = next[0];
      if (first) {
        setProfileId(first.id);
        applyProfile(first);
      }
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

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
    const jobId = ++activeLayoutJobRef.current;

    if (!safeNodes.length) {
      setNodes([]);
      setEdges([]);
      setShowMiniMap(false);
      setLayoutNote('');
      return;
    }

    const mode = chooseLayoutMode(safeNodes.length);
    setEdgeStyleMode(styleModeFor(safeNodes.length));
    const gridNodes = normalizeNodePositions(computeGridPositions(safeNodes));
    const gridEdges = mode === 'perf' ? simplifyEdgesForPerf(safeEdges) : safeEdges;

    setLayouting(false);
    setLayoutNote(mode === 'search' ? 'Large schema: use search/focus (not implemented yet)' : '');
    setEdges(gridEdges);
    setNodes(gridNodes);
    if (fit) requestFitView('grid');

    if (mode === 'search') return;

    const tooBig = safeNodes.length > 180 || safeEdges.length > 420;
    if (tooBig) {
      setLayouting(false);
      setLayoutNote('Fast layout');
      return;
    }

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

      const { positions } = await Promise.race([elkPromise, budgetPromise]);
      if (activeLayoutJobRef.current !== jobId) return;

      const laidOutNodes = normalizeNodePositions(
        gridNodes.map((n) => {
          const p = positions[n.id];
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        })
      );

      const finalEdges = mode === 'perf' ? simplifyEdgesForPerf(safeEdges) : safeEdges;
      setEdges(finalEdges);
      setNodes(laidOutNodes);
      setLayouting(false);
      setLayoutNote('');
      if (fit) requestFitView('elk');
    } catch (e) {
      if (activeLayoutJobRef.current !== jobId) return;
      setLayouting(false);
      if (e?.code === 'LAYOUT_BUDGET_EXCEEDED' || e?.message === 'LAYOUT_BUDGET_EXCEEDED') {
        setLayoutNote('Fast layout');
        return;
      }
      setLayoutNote('Fast layout');
      setError((curr) => curr || (e?.message || String(e)));
    }
  }

  async function exportDiagram() {
    const flowEl = document.querySelector('.react-flow');
    const viewportEl = flowViewportRef.current;
    const el = exportScope === 'viewport' ? viewportEl || flowEl : flowEl;
    if (!el || !flowEl) return;

    const instance = window.__rfInstance;
    const prevViewport = instance?.getViewport?.();
    const prevWidth = flowEl.style.width;
    const prevHeight = flowEl.style.height;

    function computeCropRectInElementPx({ instance, nodes, elementWidth, elementHeight, exportScale }) {
      const bounds = getNodesBounds(nodes);
      if (!bounds?.width || !bounds?.height) return null;

      const vp = instance?.getViewport?.();
      if (!vp) return null;

      const padRatio = 0.05;
      const padX = Math.max(24, bounds.width * padRatio);
      const padY = Math.max(24, bounds.height * padRatio);

      const minX = bounds.x - padX;
      const minY = bounds.y - padY;
      const maxX = bounds.x + bounds.width + padX;
      const maxY = bounds.y + bounds.height + padY;

      const left = minX * vp.zoom + vp.x;
      const top = minY * vp.zoom + vp.y;
      const right = maxX * vp.zoom + vp.x;
      const bottom = maxY * vp.zoom + vp.y;

      const cl = Math.max(0, Math.min(elementWidth, left));
      const ct = Math.max(0, Math.min(elementHeight, top));
      const cr = Math.max(0, Math.min(elementWidth, right));
      const cb = Math.max(0, Math.min(elementHeight, bottom));

      return {
        cropX: cl * exportScale,
        cropY: ct * exportScale,
        cropW: Math.max(1, (cr - cl) * exportScale),
        cropH: Math.max(1, (cb - ct) * exportScale),
      };
    }

    async function cropDataUrl(dataUrl, { cropX, cropY, cropW, cropH, mimeType, quality }) {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(cropW));
      canvas.height = Math.max(1, Math.floor(cropH));
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;

      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(mimeType, quality);
    }

    try {
      if (exportScope === 'entire' && instance) {
        const exportNodes = instance.getNodes();
        const bounds = getNodesBounds(exportNodes);
        const padRatio = 0.05;
        const padX = Math.max(24, Math.ceil(bounds.width * padRatio));
        const padY = Math.max(24, Math.ceil(bounds.height * padRatio));
        const width = Math.max(1, Math.ceil(bounds.width + padX * 2));
        const height = Math.max(1, Math.ceil(bounds.height + padY * 2));

        flowEl.style.width = `${width}px`;
        flowEl.style.height = `${height}px`;

        const { x, y, zoom } = getTransformForBounds(bounds, width, height, 0, 2);
        instance.setViewport({ x, y, zoom }, { duration: 0 });
      }

      const toDataUrl = exportFormat === 'jpg' ? htmlToImage.toJpeg : htmlToImage.toPng;
      const cropRect =
        exportScope === 'entire' && instance
          ? computeCropRectInElementPx({
              instance,
              nodes: instance.getNodes(),
              elementWidth: flowEl.clientWidth,
              elementHeight: flowEl.clientHeight,
              exportScale,
            })
          : null;

      const dataUrl = await toDataUrl(el, {
        pixelRatio: exportScale,
        backgroundColor: '#0b0d12',
        style: {
          transform: 'none',
          transformOrigin: 'top left',
        },
        filter: (node) => {
          const cls = node?.classList;
          if (!cls) return true;
          if (cls.contains('react-flow__minimap')) return false;
          if (cls.contains('react-flow__controls')) return false;
          return true;
        },
      });

      let finalUrl = dataUrl;
      if (exportScope === 'entire' && cropRect) {
        finalUrl = await cropDataUrl(dataUrl, {
          cropX: cropRect.cropX,
          cropY: cropRect.cropY,
          cropW: cropRect.cropW,
          cropH: cropRect.cropH,
          mimeType: exportFormat === 'jpg' ? 'image/jpeg' : 'image/png',
          quality: exportFormat === 'jpg' ? 0.95 : undefined,
        });
      }

      if (exportFormat === 'pdf') {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = finalUrl;
        });
        const pdf = new jsPDF({ orientation: img.width >= img.height ? 'landscape' : 'portrait', unit: 'px', format: [img.width, img.height] });
        pdf.addImage(finalUrl, 'PNG', 0, 0, img.width, img.height);
        pdf.save('schema.pdf');
      } else {
        const a = document.createElement('a');
        a.download = `schema.${exportFormat}`;
        a.href = finalUrl;
        a.click();
      }
    } finally {
      if (exportScope === 'entire') {
        flowEl.style.width = prevWidth;
        flowEl.style.height = prevHeight;
        if (instance && prevViewport) instance.setViewport(prevViewport, { duration: 0 });
      }
    }
  }

  async function applySnapshotToGraph(snap, { fit = true } = {}) {
    if (!snap) return;

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
    for (const [, list] of columnsByTableId) list.sort((a, b) => (a.attnum || 0) - (b.attnum || 0));

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
      position: { x: 0, y: 0 },
      data: {
        table: t,
        columns: columnsByTableId.get(t.id) || [],
        fkColumns: fkColsByTableId.get(t.id) || new Set(),
        indexedColumns: indexedColsByTableId.get(t.id) || new Set(),
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
        return fk.fromTableId?.startsWith(`${schemaFilter}.`) || fk.toTableId?.startsWith(`${schemaFilter}.`);
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

    try {
      rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
    } catch {
      // ignore
    }

    const cacheKey = JSON.stringify({
      schema: schemaFilter,
      showViews,
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
        const resp = await api('/schema/snapshot', {
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            connectionString: active.connectionString || '',
            pooler: active.connectionString
              ? undefined
              : { ...(active.pooler || {}), password: active.pooler?.password || schemaPassword || '' },
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

  useEffect(() => {
    if (!fullSnapshot) return;
    void applySnapshotToGraph(fullSnapshot, { fit: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaFilter, showViews, showEnums, showFunctions]);

  useEffect(() => {
    if (!pendingFitRef.current) return;
    if (!nodes?.length) return;

    pendingFitRef.current = false;
    pendingFitReasonRef.current = '';

    try {
      rf.fitView({ nodes, padding: 0.02, duration: 0, minZoom: minZoomLevel, maxZoom: 2 });
      window.setTimeout(() => {
        try {
          rf.fitView({ nodes, padding: 0.02, duration: 220, minZoom: minZoomLevel, maxZoom: 2 });
        } catch {
          // ignore
        }
      }, 30);
    } catch {
      // ignore
    }

    updateMiniMapVisibility(nodes);
  }, [nodes, rf, minZoomLevel, updateMiniMapVisibility]);

  const onMoveEnd = useCallback(() => {
    updateMiniMapVisibility();
  }, [updateMiniMapVisibility]);

  useEffect(() => {
    return () => {
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const el = flowViewportRef.current;
    if (!el) return undefined;

    const update = () => {
      setFlowViewportSize({ w: el.clientWidth || 0, h: el.clientHeight || 0 });
    };

    update();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }

    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
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
    for (const [, list] of columnsByTableId) list.sort((a, b) => (a.attnum || 0) - (b.attnum || 0));

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

  const effectiveEdgeTypes = useMemo(() => (edgeStyleMode === 'perf' ? {} : edgeTypes), [edgeStyleMode, edgeTypes]);

  const graphBounds = useMemo(() => {
    if (!nodes.length) return null;
    const b = getNodesBounds(nodes);
    const padX = 16;
    const padY = 8;
    const minX = Math.floor(b.x - padX);
    const minY = Math.floor(b.y - padY);
    const maxX = Math.ceil(b.x + b.width + padX);
    const maxY = Math.ceil(b.y + b.height + padY);
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }, [nodes]);

  useEffect(() => {
    if (!graphBounds) return;
    if (!flowViewportSize.w || !flowViewportSize.h) return;

    const verticalGapPx = 18;
    const visibleHeight = Math.max(1, flowViewportSize.h - verticalGapPx * 2);
    const heightZoom = visibleHeight / Math.max(1, graphBounds.height);
    const nextMinZoom = Math.max(0.02, Math.min(2, heightZoom));

    setMinZoomLevel((curr) => (Math.abs(curr - nextMinZoom) < 0.0001 ? curr : nextMinZoom));
    setTranslateExtent([
      [graphBounds.minX, graphBounds.minY],
      [graphBounds.maxX, graphBounds.maxY],
    ]);
  }, [graphBounds, flowViewportSize.w, flowViewportSize.h]);

  const flowCanvasStyle = useMemo(() => {
    if (!nodes.length) return { width: '100%', height: '100%' };

    const contentWidth = Math.ceil(Math.max(1, graphBounds?.maxX || 1));
    const contentHeight = Math.ceil(Math.max(1, graphBounds?.maxY || 1));
    const width = Math.max(contentWidth, flowViewportSize.w || 0);
    const height = Math.max(contentHeight, flowViewportSize.h || 0);
    return { width: `${width}px`, height: `${height}px` };
  }, [nodes, graphBounds, flowViewportSize.w, flowViewportSize.h]);

  return (
    <div className="schema-screen">
      <div className="schema-layout">
        <div className="card schema-left" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="section">
            <h3 style={{ margin: 0 }}>Schema visualizer</h3>
            <div className="hint">Loads schema metadata from PostgreSQL catalogs and renders tables + FK relations.</div>
          </div>

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
                  <textarea value={customJson} onChange={(e) => setCustomJson(e.target.value)} placeholder="Paste /api/schema/snapshot response.snapshot JSON here…" style={{ minHeight: 140 }} />
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

          {sourceMode === 'db' ? (
            <div className="section">
              <div className="section-title">Connection</div>
              <div className="form-grid">
                <div className="field full">
                  <div className="field-label">Profile</div>
                  <select value={profileId} onChange={(e) => onSelectProfile(e.target.value)}>
                    <option value="">— Select profile —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <div className="field-hint">Uses profiles from Run tab (stored in localStorage). Password is never stored.</div>
                </div>

                {!active.connectionString ? (
                  <div className="field full">
                    <div className="field-label">Pooler password</div>
                    <input type="password" value={schemaPassword} onChange={(e) => setSchemaPassword(e.target.value)} placeholder="Enter password to load schema…" />
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
                  <div className="hint" style={{ marginTop: 6 }}>Enter the pooler password above (or paste a full connection string in Run, then return).</div>
                </div>
              ) : null}
            </div>
          ) : null}

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
                      <option key={s} value={s}>{s}</option>
                    ))}
                </select>
              </div>
            </div>

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
          </div>

          <div className="section">
            <div className="section-title">Export</div>
            <div className="form-grid">
              <div className="field full">
                <button className="btn" type="button" onClick={exportDiagram} disabled={nodes.length === 0}>Export</button>
                <div className="field-hint" style={{ marginTop: 6 }}>Tip: choose “Entire diagram” to export all nodes (it temporarily resizes the viewport to capture everything).</div>
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

          <div className="section">
            <div className="section-title">Profiles JSON</div>
            <div className="hint">Paste profiles JSON (connections) here and click “Load profiles”. Password is never stored.</div>

            <div style={{ height: 10 }} />

            <textarea value={profilesJson} onChange={(e) => setProfilesJson(e.target.value)} placeholder="Paste profiles JSON array here…" style={{ minHeight: 140 }} />

            <div className="toolbar" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
              <button className="btn primary" type="button" onClick={loadProfilesFromJsonTextAndApplyFirst}>Load profiles</button>
            </div>
            <div className="field-hint" style={{ marginTop: 8 }}>
              Stored key: <span className="mono">{getStorageKey('profiles')}</span>
            </div>
          </div>

          {error ? (
            <div className="alert warn">
              <div style={{ fontWeight: 800 }}>Schema load failed</div>
              <div className="hint" style={{ marginTop: 6 }}>{error}</div>
            </div>
          ) : null}

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
                              {i.name}
                              {i.isPrimary ? ' [PK]' : ''}
                              {i.isUnique ? ' [UNIQUE]' : ''}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="hint">—</div>
                      )}

                      <div className="hint" style={{ fontWeight: 800 }}>RLS</div>
                      <div className="mono">
                        enabled: {rls?.enabled ? 'true' : 'false'}
                        {'\n'}forced: {rls?.forced ? 'true' : 'false'}
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          </div>

          {showEnums && snapshot?.enums?.length ? (
            <div className="section">
              <div className="section-title">Enums</div>
              <div className="card" style={{ padding: 10 }}>
                {(() => {
                  const list = snapshot.enums || [];
                  const limit = 5;
                  const show = enumsExpanded ? list : list.slice(0, limit);
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
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{e.schema}</td>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{e.name}</td>
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

                      {enumsExpanded && list.length > limit ? (
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
                  const limit = 5;
                  const show = functionsExpanded ? list : list.slice(0, limit);
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
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{f.schema}</td>
                                <td className="mono" style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>{f.name}</td>
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

                      {functionsExpanded && list.length > limit ? (
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

        <div className="card schema-right" style={{ padding: 0 }}>
          <div className="schema-flow-viewport" ref={flowViewportRef}>
            <div className="schema-flow-canvas" style={flowCanvasStyle}>
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
                    setSelectedTableId((curr) => (curr === node.id ? null : node.id));
                  }}
                  onInit={(inst) => {
                    window.__rfInstance = inst;
                  }}
                  fitView
                  minZoom={minZoomLevel}
                  maxZoom={2}
                  zoomOnScroll={false}
                  preventScrolling={false}
                  translateExtent={translateExtent}
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
      </div>
    </div>
  );
}

export function SchemaScreenWithProvider() {
  return (
    <ReactFlowProvider>
      <SchemaScreen />
    </ReactFlowProvider>
  );
}
