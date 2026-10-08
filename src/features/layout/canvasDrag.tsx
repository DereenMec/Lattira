import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { t } from "@/i18n";
import { projectLabel, useAppStore } from "@/store/appStore";
import type { CanvasMeta, ID } from "@/types/model";

/**
 * 把画布拖到侧栏的项目上以移动它。
 * 用指针事件自己实现，而不是 HTML5 拖放：桌面端为了接收系统文件拖放，WebView 内的 HTML5 拖放不可用。
 */
interface CanvasDragState {
  drag: { canvasId: ID; title: string; x: number; y: number; overProjectId: ID | null } | null;
}

export const useCanvasDrag = create<CanvasDragState>(() => ({ drag: null }));

const THRESHOLD = 6;
let suppressClick = false;

/** 拖动结束时会紧跟一次 click，卡片的 onClick 先调用它判断是否应忽略 */
export function consumeDragClick(): boolean {
  const s = suppressClick;
  suppressClick = false;
  return s;
}

const dropTargetAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-project]")?.dataset.dropProject ?? null;

export function startCanvasDrag(e: ReactPointerEvent, canvas: CanvasMeta) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;

  const onMove = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
      started = true;
      document.body.classList.add("is-dragging-canvas");
    }
    useCanvasDrag.setState({
      drag: { canvasId: canvas.id, title: canvas.title, x: ev.clientX, y: ev.clientY, overProjectId: dropTargetAt(ev.clientX, ev.clientY) },
    });
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const target = useCanvasDrag.getState().drag?.overProjectId;
    useCanvasDrag.setState({ drag: null });
    document.body.classList.remove("is-dragging-canvas");
    if (!started) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    if (target && target !== canvas.projectId) void moveCanvas(canvas, target);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function moveCanvas(canvas: CanvasMeta, projectId: ID) {
  const app = useAppStore.getState();
  const project = app.projects.find((p) => p.id === projectId);
  try {
    await app.updateCanvas(canvas.id, { projectId });
    app.showToast(t("已把「{canvas}」移到「{project}」", { canvas: canvas.title, project: project ? projectLabel(project) : t("项目") }));
  } catch (e) {
    app.showToast(t("移动失败：{error}", { error: String(e) }));
  }
}

/** 拖动时跟随指针的标签 */
export function CanvasDragGhost() {
  const drag = useCanvasDrag((s) => s.drag);
  if (!drag) return null;
  return (
    <div className={`drag-ghost${drag.overProjectId ? " is-over" : ""}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
      {drag.title}
    </div>
  );
}
