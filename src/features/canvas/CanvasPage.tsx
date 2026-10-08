import { GripVertical, PanelRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { startCanvasDrag } from "@/features/layout/canvasDrag";
import { confirmAction } from "@/services/confirm";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { ID } from "@/types/model";
import { CanvasView } from "./CanvasView";
import { Inspector } from "./Inspector";

const SAVE_LABEL = { saved: "已保存", pending: "编辑中…", saving: "保存中…", error: "保存失败" } as const;

export function CanvasPage({ canvasId, focusElementId, focusAssetId }: { canvasId: ID; focusElementId?: ID; focusAssetId?: ID }) {
  const meta = useAppStore((s) => s.canvases.find((c) => c.id === canvasId));
  const projects = useAppStore((s) => s.projects);
  const inspectorOpen = useAppStore((s) => s.inspectorOpen);
  const saveState = useCanvasStore((s) => s.saveState);
  const [title, setTitle] = useState(meta?.title ?? "");

  useEffect(() => setTitle(meta?.title ?? ""), [meta?.title]);

  if (!meta) return <div className="empty-page">画布不存在或已被删除。</div>;
  const project = projects.find((p) => p.id === meta.projectId);
  const { navigate, updateCanvas, showToast } = useAppStore.getState();

  const commitTitle = () => {
    const t = title.trim();
    if (!t) setTitle(meta.title);
    else if (t !== meta.title) void updateCanvas(meta.id, { title: t }).catch((e) => showToast(`重命名失败：${String(e)}`));
  };

  const remove = async () => {
    if (!(await confirmAction(`删除画布「${meta.title}」？画布文件会移到工作区的回收站文件夹。`))) return;
    await useAppStore.getState().deleteCanvas(meta.id);
  };

  return (
    <div className="page canvas-page">
      <header className="topbar">
        <span className="drag-handle" onPointerDown={(e) => startCanvasDrag(e, meta)} title="拖到左侧项目上可移动这个画布">
          <GripVertical size={16} />
        </span>
        <button className="crumb" onClick={() => navigate({ kind: "project", projectId: meta.projectId })}>
          {project?.name}
        </button>
        <span className="crumb-sep">/</span>
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setTitle(meta.title);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className={`save-state is-${saveState}`}>{SAVE_LABEL[saveState]}</span>
        <div className="topbar-actions">
          <label className="select-label">
            所属项目
            <select
              value={meta.projectId}
              onChange={(e) => void updateCanvas(meta.id, { projectId: e.target.value }).catch((err) => showToast(`移动失败：${String(err)}`))}
            >
              {projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="icon-btn" onClick={() => void remove()} title="删除画布">
            <Trash2 size={16} />
          </button>
          <button
            className={`icon-btn${inspectorOpen ? " is-on" : ""}`}
            onClick={() => useAppStore.getState().toggleInspector()}
            title="显示 / 隐藏检查器"
          >
            <PanelRight size={16} />
          </button>
        </div>
      </header>
      <div className="canvas-body">
        <CanvasView canvasId={canvasId} focusElementId={focusElementId} focusAssetId={focusAssetId} />
        {inspectorOpen && <Inspector meta={meta} />}
      </div>
    </div>
  );
}
