import { CalendarDays, Clock, FolderOpen, Inbox, Info, Languages, Library, Plus, Search } from "lucide-react";
import { useState } from "react";
import { openAbout } from "@/features/about/AboutDialog";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { projectMenu } from "@/features/menu/menus";
import { ProjectIcon } from "@/features/project/projectIcons";
import { setLocale, useLocale, useT } from "@/i18n";
import { inboxOf, useAppStore, type View } from "@/store/appStore";
import type { ID } from "@/types/model";
import { useCanvasDrag } from "./canvasDrag";

export function Sidebar() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const projects = useAppStore((s) => s.projects);
  const canvases = useAppStore((s) => s.canvases);
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const dropOver = useCanvasDrag((s) => s.drag?.overProjectId ?? null);
  const dragging = useCanvasDrag((s) => s.drag !== null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const inbox = inboxOf(projects);
  const currentProjectId =
    view.kind === "project" ? view.projectId : view.kind === "canvas" ? canvases.find((c) => c.id === view.canvasId)?.projectId : undefined;
  const userProjects = projects.filter((p) => !p.isInbox && !p.archived);
  const countOf = (projectId: string) => canvases.filter((c) => c.projectId === projectId).length;
  const is = (kind: View["kind"]) => view.kind === kind;
  /** 项目条目同时是画布拖放的目标 */
  const projectClass = (id: ID) =>
    `nav-item${currentProjectId === id ? " is-active" : ""}${dragging ? " is-drop-target" : ""}${dropOver === id ? " is-drop-over" : ""}`;

  const submit = async () => {
    const trimmed = name.trim();
    setCreating(false);
    setName("");
    if (trimmed) await useAppStore.getState().createProject(trimmed);
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <img src="/lattira.svg" alt="" width={22} height={22} />
        <div className="brand">{t("栖页")}</div>
        <button className="icon-btn head-btn" onClick={openAbout} title={t("关于")}>
          <Info size={15} />
        </button>
        <button
          className="icon-btn head-btn lang-btn"
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          title={locale === "zh" ? "Switch to English" : "切换到中文"}
        >
          <Languages size={15} />
          <span>{locale === "zh" ? "EN" : "中"}</span>
        </button>
      </div>

      <button className="nav-item search-trigger" onClick={() => useAppStore.getState().setSearchOpen(true)}>
        <Search size={16} />
        <span>{t("搜索")}</span>
        <kbd>Ctrl E</kbd>
      </button>

      <button className={`nav-item${is("recent") ? " is-active" : ""}`} onClick={() => navigate({ kind: "recent" })}>
        <Clock size={16} />
        <span>{t("最近")}</span>
      </button>
      {inbox && (
        <button
          className={projectClass(inbox.id)}
          data-drop-project={inbox.id}
          onContextMenu={(e) => openContextMenu(e, projectMenu(inbox))}
          onClick={() => navigate({ kind: "project", projectId: inbox.id })}
        >
          <Inbox size={16} />
          <span>{t("未分类")}</span>
          <span className="count">{countOf(inbox.id)}</span>
        </button>
      )}
      <button className={`nav-item${is("calendar") ? " is-active" : ""}`} onClick={() => navigate({ kind: "calendar" })}>
        <CalendarDays size={16} />
        <span>{t("日历")}</span>
      </button>
      <button className={`nav-item${is("assets") ? " is-active" : ""}`} onClick={() => navigate({ kind: "assets" })}>
        <Library size={16} />
        <span>{t("资源库")}</span>
      </button>

      <div className="nav-group">
        <span>{t("项目")}</span>
        <button className="icon-btn" onClick={() => setCreating(true)} title={t("新建项目")}>
          <Plus size={14} />
        </button>
      </div>
      {creating && (
        <input
          className="nav-input"
          autoFocus
          placeholder={t("项目名称")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void submit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") {
              setName("");
              setCreating(false);
            }
          }}
        />
      )}
      <div className="nav-projects">
        {userProjects.map((p) => (
          <button
            key={p.id}
            className={projectClass(p.id)}
            data-drop-project={p.id}
            onContextMenu={(e) => openContextMenu(e, projectMenu(p))}
            onClick={() => navigate({ kind: "project", projectId: p.id })}
          >
            <ProjectIcon project={p} />
            <span className="label">{p.name}</span>
            <span className="count">{countOf(p.id)}</span>
          </button>
        ))}
        {userProjects.length === 0 && !creating && <p className="nav-empty">{t("还没有项目，点 + 新建一个")}</p>}
      </div>

      <button className="nav-item ws-switch" onClick={() => void useAppStore.getState().pickWorkspace()}>
        <FolderOpen size={16} />
        <span>{t("切换工作区")}</span>
      </button>
    </nav>
  );
}
