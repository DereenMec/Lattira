import { CalendarDays, FolderOpen, Inbox, Library, Plus, Search } from "lucide-react";
import { useState } from "react";
import { inboxOf, useAppStore, type View } from "@/store/appStore";

export function Sidebar() {
  const workspace = useAppStore((s) => s.workspace);
  const projects = useAppStore((s) => s.projects);
  const canvases = useAppStore((s) => s.canvases);
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const inbox = inboxOf(projects);
  const currentProjectId =
    view.kind === "project" ? view.projectId : view.kind === "canvas" ? canvases.find((c) => c.id === view.canvasId)?.projectId : undefined;
  const userProjects = projects.filter((p) => !p.isInbox && !p.archived);
  const countOf = (projectId: string) => canvases.filter((c) => c.projectId === projectId).length;
  const is = (kind: View["kind"]) => view.kind === kind;

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
        <div>
          <div className="brand">栖页</div>
          <div className="ws-name" title={workspace?.path}>
            {workspace?.name}
          </div>
        </div>
      </div>

      <button className="nav-item search-trigger" onClick={() => useAppStore.getState().setSearchOpen(true)}>
        <Search size={16} />
        <span>搜索</span>
        <kbd>Ctrl K</kbd>
      </button>

      {inbox && (
        <button
          className={`nav-item${currentProjectId === inbox.id ? " is-active" : ""}`}
          onClick={() => navigate({ kind: "project", projectId: inbox.id })}
        >
          <Inbox size={16} />
          <span>收件箱</span>
          <span className="count">{countOf(inbox.id)}</span>
        </button>
      )}
      <button className={`nav-item${is("calendar") ? " is-active" : ""}`} onClick={() => navigate({ kind: "calendar" })}>
        <CalendarDays size={16} />
        <span>日历</span>
      </button>
      <button className={`nav-item${is("assets") ? " is-active" : ""}`} onClick={() => navigate({ kind: "assets" })}>
        <Library size={16} />
        <span>资源库</span>
      </button>

      <div className="nav-group">
        <span>项目</span>
        <button className="icon-btn" onClick={() => setCreating(true)} title="新建项目">
          <Plus size={14} />
        </button>
      </div>
      {creating && (
        <input
          className="nav-input"
          autoFocus
          placeholder="项目名称"
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
            className={`nav-item${currentProjectId === p.id ? " is-active" : ""}`}
            onClick={() => navigate({ kind: "project", projectId: p.id })}
          >
            <span className="dot" style={{ background: p.color }} />
            <span className="label">{p.name}</span>
            <span className="count">{countOf(p.id)}</span>
          </button>
        ))}
        {userProjects.length === 0 && !creating && <p className="nav-empty">还没有项目，点 + 新建一个</p>}
      </div>

      <button className="nav-item ws-switch" onClick={() => void useAppStore.getState().pickWorkspace()}>
        <FolderOpen size={16} />
        <span>切换工作区</span>
      </button>
    </nav>
  );
}
