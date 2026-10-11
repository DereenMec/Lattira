import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { canvasAncestor } from "@/lib/folders";
import { center, rectEdgePoint, type Point } from "@/lib/geometry";
import type { CanvasElement, Edge, ID } from "@/types/model";

interface Props {
  edges: Edge[];
  elements: CanvasElement[];
  selectedEdgeId: ID | null;
  /** 正在拖出的连线预览 */
  pending: { fromId: ID; to: Point } | null;
  onSelect(id: ID): void;
  onContextMenu(e: ReactMouseEvent, id: ID): void;
}

function EdgeLayerImpl({ edges, elements, selectedEdgeId, pending, onSelect, onContextMenu }: Props) {
  const byId = new Map(elements.map((e) => [e.id, e]));

  const segment = (from: CanvasElement, toPoint: Point, to?: CanvasElement) => {
    const a = rectEdgePoint(from, to ? center(to) : toPoint);
    const b = to ? rectEdgePoint(to, center(from)) : toPoint;
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
        const d = segment(from, center(to), to);
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
              markerEnd={selected ? "url(#edge-arrow-selected)" : "url(#edge-arrow)"}
            />
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
