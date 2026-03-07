/* eslint-disable no-restricted-globals */
import ELK from 'elkjs/lib/elk.bundled.js';

// Web worker for ELK layout so the UI thread stays responsive.
// Message format:
//   { id: string, nodes: [{id,width,height}], edges: [{id,source,target}], mode: 'full'|'perf' }
// Response:
//   { id: string, ok: true, positions: Record<string,{x:number,y:number}>, mode }
//   { id: string, ok: false, error: string }

const elk = new ELK();

function buildLayoutOptions(mode) {
  const full = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '220',
    'elk.layered.spacing.nodeNodeBetweenLayers': '420',
    'elk.layered.spacing.edgeNodeBetweenLayers': '200',
    'elk.spacing.edgeNode': '120',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '80',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN',
    'elk.layered.crossingMinimization.semiInteractive': 'true',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  };

  // Performance mode: keep layered (good at reducing crossings) but avoid orthogonal routing.
  // This speeds up and reduces complexity for larger graphs.
  const perf = {
    ...full,
    'elk.edgeRouting': 'POLYLINE',
    'elk.layered.spacing.nodeNodeBetweenLayers': '320',
    'elk.spacing.nodeNode': '160',
    'elk.layered.crossingMinimization.semiInteractive': 'false',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
  };

  return mode === 'perf' ? perf : full;
}

self.onmessage = async (evt) => {
  const msg = evt.data;
  const id = msg?.id;
  try {
    const nodes = Array.isArray(msg?.nodes) ? msg.nodes : [];
    const edges = Array.isArray(msg?.edges) ? msg.edges : [];
    const mode = msg?.mode === 'perf' ? 'perf' : 'full';

    const graph = {
      id: 'root',
      layoutOptions: buildLayoutOptions(mode),
      children: nodes.map((n) => ({ id: n.id, width: n.width || 360, height: n.height || 320 })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };

    const laidOut = await elk.layout(graph);
    const positions = {};
    for (const c of laidOut.children || []) {
      positions[c.id] = { x: c.x || 0, y: c.y || 0 };
    }

    self.postMessage({ id, ok: true, positions, mode });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
};
