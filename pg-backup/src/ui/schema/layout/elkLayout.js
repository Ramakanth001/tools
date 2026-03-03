import ELK from 'elkjs/lib/elk.bundled.js';

/**
 * Compute ELK positions for React Flow nodes.
 *
 * @param {object} params
 * @param {Array<{id:string, width?:number, height?:number}>} params.nodes
 * @param {Array<{id:string, source:string, target:string}>} params.edges
 */
export async function computeElkLayout({ nodes, edges }) {
  const elk = new ELK();

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '120',
      'elk.layered.spacing.nodeNodeBetweenLayers': '220',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width || 360,
      height: n.height || 320,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laidOut = await elk.layout(graph);
  const pos = new Map();
  for (const c of laidOut.children || []) {
    pos.set(c.id, { x: c.x || 0, y: c.y || 0 });
  }
  return pos;
}
