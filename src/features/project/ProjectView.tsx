import { Archive, Plus, Shapes } from "lucide-react";
import { useEffect, useState } from "react";
import { confirmAction } from "@/services/confirm";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/appStore";
import type { ID } from "@/types/model";
import { CanvasCard } from "./CanvasCard";
import { CanvasListActions } from "./CanvasListActions";
import { ProjectIcon } from "./projectIcons";
import { openProjectStyle } from "./ProjectStyleDialog";

export function ProjectView({ projectId }: { projectId: ID }) {
  const t = useT();
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const allCanvases = useAppStore((s) => s.canvases);
  const [name, setName] = useState(project?.name ?? "");

  useEffect(() => setName(project?.name ?? ""), [project?.name]);

  if (!project) return <div className="empty-page">{t("项目不存在。")}</div>;
  const canvases = allCanvases.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  const { createCanvas, updateProject, navigate, showToast } = useAppStore.getState();

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(project.name);
    else if (trimmed !== project.name)
      void updateProject(project.id, { name: trimmed }).catch((e) => showToast(t("重命名失败：{error}", { error: String(e) })));
  };

  const archive = async () => {
    if (!(await confirmAction(t("归档项目「{name}」？归档后它不再显示在侧栏，画布仍保留在磁盘上。", { name: project.name })))) return;
    await updateProject(project.id, { archived: true });
    navigate({ kind: "calendar" });
  };

  return (
    <div className="page project-page">
      <header className="page-head">
        {!project.isInbox && (
          <button className="project-style-btn" onClick={() => openProjectStyle(project.id)} title={t("修改图标和颜色")}>
            <ProjectIcon project={project} size={20} />
          </button>
        )}
        {project.isInbox ? (
          <h1>{t("未分类")}</h1>
        ) : (
          <input
            className="page-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="page-sub">{t("{n} 个画布", { n: canvases.length })}</span>
        <div className="page-actions">
          {!project.isInbox && (
            <button className="btn ghost" onClick={() => void archive()}>
              <Archive size={14} /> {t("归档")}
            </button>
          )}
          <CanvasListActions projectId={project.id} />
        </div>
      </header>
      {project.isInbox && <p className="page-desc">{t("没有归到任何项目的画布放在这里。把画布卡片拖到左侧的项目上，就能移过去。")}</p>}

      {canvases.length === 0 ? (
        <div className="empty-block">
          <Shapes size={28} />
          <p>{t("这个项目还没有画布")}</p>
          <button className="btn primary" onClick={() => void createCanvas(project.id)}>
            <Plus size={14} /> {t("新建画布")}
          </button>
        </div>
      ) : (
        <div className="canvas-grid">
          {canvases.map((c) => (
            <CanvasCard key={c.id} canvas={c} />
          ))}
        </div>
      )}
    </div>
  );
}
