import { formatRelative } from "@/lib/date";
import { consumeDragClick, startCanvasDrag } from "@/features/layout/canvasDrag";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { canvasMenu } from "@/features/menu/menus";
import { useT } from "@/i18n";
import { projectLabel, useAppStore } from "@/store/appStore";
import type { CanvasMeta } from "@/types/model";
import { CanvasThumb } from "./CanvasThumb";
import { ProjectIcon } from "./projectIcons";

/** 画布卡片：缩略图 + 标题 + 元信息；可拖到侧栏的项目上 */
export function CanvasCard({ canvas, showProject }: { canvas: CanvasMeta; showProject?: boolean }) {
  const t = useT();
  const project = useAppStore((s) => (showProject ? s.projects.find((p) => p.id === canvas.projectId) : undefined));
  return (
    <button
      className="canvas-card"
      onPointerDown={(e) => startCanvasDrag(e, canvas)}
      onContextMenu={(e) => openContextMenu(e, canvasMenu(canvas))}
      onClick={() => {
        if (!consumeDragClick()) useAppStore.getState().navigate({ kind: "canvas", canvasId: canvas.id });
      }}
      title={t("点击打开，拖到左侧项目上可移动")}
    >
      <div className="canvas-card-thumb">
        <CanvasThumb preview={canvas.preview} />
      </div>
      <div className="canvas-card-title">{canvas.title}</div>
      <div className="canvas-card-meta">
        {project && (
          <>
            <ProjectIcon project={project} size={13} />
            <span className="canvas-card-project">{projectLabel(project)}</span>
            <span>·</span>
          </>
        )}
        <span>
          {t("{n} 个元素", { n: canvas.elementCount })} · {formatRelative(canvas.updatedAt)}
        </span>
      </div>
    </button>
  );
}
