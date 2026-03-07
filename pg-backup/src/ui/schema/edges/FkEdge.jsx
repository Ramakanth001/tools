import React, { memo, useMemo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow } from 'reactflow';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rectIntersects(r, p) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * FK edge with collision-avoid label placement.
 *
 * Strategy:
 * - Compute smoothstep edge path.
 * - Start with label at the path center.
 * - If it collides with any node bbox, slide along the edge direction.
 */
function FkEdgeImpl(props) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    style,
    label,
    data,
  } = props;

  const rf = useReactFlow();

  const [edgePath, centerX, centerY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
  });

  const labelPos = useMemo(() => {
    const nodes = rf.getNodes();

    // Approx label size in px.
    const w = clamp((String(label || '').length || 8) * 7.2 + 22, 90, 280);
    const h = 26;

    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Perp direction
    const px = -uy;
    const py = ux;

    // Try a few offsets along the edge and perpendicular.
    const candidates = [];
    for (const t of [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36]) {
      for (const p of [0, 20, -20, 36, -36, 52, -52]) {
        candidates.push({
          x: centerX + ux * len * t + px * p,
          y: centerY + uy * len * t + py * p,
        });
      }
    }

    const rects = nodes
      .map((n) => {
        const w = n.measured?.width || 360;
        const h = n.measured?.height || 320;
        return { x: n.positionAbsolute?.x ?? n.position.x, y: n.positionAbsolute?.y ?? n.position.y, w, h };
      })
      // add padding around nodes
      .map((r) => ({ ...r, x: r.x - 18, y: r.y - 18, w: r.w + 36, h: r.h + 36 }));

    for (const c of candidates) {
      const p = { x: c.x, y: c.y };
      const collides = rects.some((r) => rectIntersects(r, p));
      if (!collides) return { x: c.x, y: c.y, w, h };
    }

    // Fallback: push perpendicular.
    return { x: centerX + px * 42, y: centerY + py * 42, w, h };
  }, [rf, centerX, centerY, sourceX, sourceY, targetX, targetY, label]);

  const lbl = String(label || data?.label || '');

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPos.x}px,${labelPos.y}px)`,
            pointerEvents: 'none',
            zIndex: 60,
          }}
        >
          <div
            style={{
              maxWidth: 320,
              fontSize: 10,
              fontWeight: 800,
              color: 'rgba(238,242,255,0.9)',
              background: 'rgba(17, 24, 42, 0.94)',
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 10,
              padding: '6px 10px',
              boxShadow: '0 10px 26px rgba(0,0,0,0.35)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={lbl}
          >
            {lbl}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const FkEdge = memo(FkEdgeImpl);
export default FkEdge;
