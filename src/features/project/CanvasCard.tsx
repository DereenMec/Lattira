import { formatRelative } from "@/lib/date";
import { consumeDragClick, startCanvasDrag } from "@/features/layout/canvasDrag";
import { useAppStore } from "@/store/appStore";
import type { CanvasMeta } from "@/types/model";
import { CanvasThumb } from "./CanvasThumb";

/** 画布卡片：缩略图 + 标题 + 元信息；可拖到侧栏的项目上 */
export function CanvasCard({ canvas, showProject }: { canvas: CanvasMeta; showProject?: boolean }) {
  const project = useAppStore((s) => (showProject ? s.projects.find((p) => p.id === canvas.projectId) : undefined));
  return (
    <button
      className="canvas-card"
      onPointerDown={(e) => startCanvasDrag(e, canvas)}
      onClick={() => {
        if (!consumeDragClick()) useAppStore.getState().navigate({ kind: "canvas", canvasId: canvas.id });
      }}
      title="点击打开，拖到左侧项目上可移动"
    >
      <div className="canvas-card-thumb">
        <CanvasThumb preview={canvas.preview} />
      </div>
      <div className="canvas-card-title">{canvas.title}</div>
      <div className="canvas-card-meta">
        {project && (
          <>
            <span className="dot" style={{ background: project.color }} />
            <span className="canvas-card-project">{project.name}</span>
            <span>·</span>
          </>
        )}
        <span>
          {canvas.elementCount} 个元素 · {formatRelative(canvas.updatedAt)}
        </span>
      </div>
    </button>
  );
}
