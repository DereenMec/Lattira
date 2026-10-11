import { memo, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { canvasAncestor } from "@/lib/folders";
import { center, intersects, rectEdgePoint, type Point, type Rect } from "@/lib/geometry";
import type { CanvasElement, Edge, ID } from "@/types/model";

interface Props {
  visibleRect?: Rect;
  edges: Edge[];
  elements: CanvasElement[];
  selectedEdgeId: ID | null;
  /** 正在拖出的连线预览 */
  pending: { fromId: ID; to: Point } | null;
  onSelect(id: ID): void;
  onContextMenu(e: ReactMouseEvent, id: ID): void;
}

function EdgeLayerImpl({ edges, elements, selectedEdgeId, pending, onSelect, onContextMenu, visibleRect }: Props) {
  const lookup = useRef(new Map<ID, CanvasElement>());
  const byId = useMemo(() => {
    const map = lookup.current;
    const live = new Set<ID>();
    for (const el of elements) { live.add(el.id); if (map.get(el.id) !== el) map.set(el.id, el); }
    if (map.size !== elements.length) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    return map;
  }, [elements]);

  const sidePoint = (r: CanvasElement, side: Edge["fromSide"], fallback: Point) => side === "top" ? { x: r.x + r.width / 2, y: r.y }
    : side === "bottom" ? { x: r.x + r.width / 2, y: r.y + r.height }
    : side === "left" ? { x: r.x, y: r.y + r.height / 2 }
    : side === "right" ? { x: r.x + r.width, y: r.y + r.height / 2 } : rectEdgePoint(r, fallback);
  const segment = (from: CanvasElement, toPoint: Point, to?: CanvasElement, edge?: Edge) => {
    const a = sidePoint(from, edge?.fromSide, to ? center(to) : toPoint);
    const b = to ? sidePoint(to, edge?.toSide, center(from)) : toPoint;
    return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  };

  const pendingFrom = pending ? byId.get(pending.fromId) : undefined;

  return (
    <svg className="edge-layer">
      <defs>
        <marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="edge-arrow" />
        </marker>
        <marker id="edge-arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="edge-arrow is-selected" />
        </marker>
      </defs>
      {edges.map((edge) => {
        // 一端在文件夹里时连到画布上包含它的文件夹；两端在同一个文件夹里时不画
        const from = canvasAncestor(byId, edge.fromId);
        const to = canvasAncestor(byId, edge.toId);
        if (!from || !to || from === to) return null;
        if (visibleRect && edge.id !== selectedEdgeId && !intersects(visibleRect, {
          x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
          width: Math.max(from.x + from.width, to.x + to.width) - Math.min(from.x, to.x),
          height: Math.max(from.y + from.height, to.y + to.height) - Math.min(from.y, to.y),
        })) return null;
        const d = segment(from, center(to), to, edge);
        const selected = edge.id === selectedEdgeId;
        return (
          <g key={edge.id}>
            <path
              d={d}
              className="edge-hit"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(edge.id);
              }}
              onContextMenu={(e) => onContextMenu(e, edge.id)}
            />
            <path
              d={d}
              className={selected ? "edge is-selected" : "edge"}
              style={edge.color?.startsWith("#") ? { stroke: edge.color } : undefined}
              markerStart={edge.fromEnd === "arrow" ? (selected ? "url(#edge-arrow-selected)" : "url(#edge-arrow)") : undefined}
              markerEnd={edge.toEnd === "none" ? undefined : selected ? "url(#edge-arrow-selected)" : "url(#edge-arrow)"}
            />
            {edge.label && <text x={(center(from).x + center(to).x) / 2} y={(center(from).y + center(to).y) / 2 - 6} className="edge-label">{edge.label}</text>}
          </g>
        );
      })}
      {pending && pendingFrom && (
        <path d={segment(pendingFrom, pending.to)} className="edge is-pending" markerEnd="url(#edge-arrow-selected)" />
      )}
    </svg>
  );
}

export const EdgeLayer = memo(EdgeLayerImpl);
