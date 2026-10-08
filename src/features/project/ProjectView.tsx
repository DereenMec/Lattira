import { Archive, Plus, Shapes } from "lucide-react";
import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/date";
import { confirmAction } from "@/services/confirm";
import { useAppStore } from "@/store/appStore";
import type { ID } from "@/types/model";

export function ProjectView({ projectId }: { projectId: ID }) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const allCanvases = useAppStore((s) => s.canvases);
  const [name, setName] = useState(project?.name ?? "");

  useEffect(() => setName(project?.name ?? ""), [project?.name]);

  if (!project) return <div className="empty-page">项目不存在。</div>;
  const canvases = allCanvases.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  const { createCanvas, updateProject, navigate, showToast } = useAppStore.getState();

  const commitName = () => {
    const t = name.trim();
    if (!t) setName(project.name);
    else if (t !== project.name) void updateProject(project.id, { name: t }).catch((e) => showToast(`重命名失败：${String(e)}`));
  };

  const archive = async () => {
    if (!(await confirmAction(`归档项目「${project.name}」？归档后它不再显示在侧栏，画布仍保留在磁盘上。`))) return;
    await updateProject(project.id, { archived: true });
    navigate({ kind: "calendar" });
  };

  return (
    <div className="page project-page">
      <header className="page-head">
        <span className="project-dot" style={{ background: project.color }} />
        {project.isInbox ? (
          <h1>收件箱</h1>
        ) : (
          <input
            className="page-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="page-sub">{canvases.length} 个画布</span>
        <div className="page-actions">
          {!project.isInbox && (
            <button className="btn ghost" onClick={() => void archive()}>
              <Archive size={14} /> 归档
            </button>
          )}
          <button className="btn primary" onClick={() => void createCanvas(project.id)}>
            <Plus size={14} /> 新建画布
          </button>
        </div>
      </header>
      {project.isInbox && <p className="page-desc">没有归类的画布放在这里。整理好后，可以在画布顶栏的「所属项目」里把它移到某个项目。</p>}

      {canvases.length === 0 ? (
        <div className="empty-block">
          <Shapes size={28} />
          <p>这个项目还没有画布</p>
          <button className="btn primary" onClick={() => void createCanvas(project.id)}>
            <Plus size={14} /> 新建画布
          </button>
        </div>
      ) : (
        <div className="canvas-grid">
          {canvases.map((c) => (
            <button key={c.id} className="canvas-card" onClick={() => navigate({ kind: "canvas", canvasId: c.id })}>
              <div className="canvas-card-thumb">
                <Shapes size={22} />
              </div>
              <div className="canvas-card-title">{c.title}</div>
              <div className="canvas-card-meta">
                {c.elementCount} 个元素 · {formatRelative(c.updatedAt)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
