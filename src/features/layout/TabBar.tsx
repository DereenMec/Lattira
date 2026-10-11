import { X } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { CanvasActions } from "@/features/canvas/CanvasPage";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { canvasMenu } from "@/features/menu/menus";
import { ProjectIcon } from "@/features/project/projectIcons";
import { t, useT } from "@/i18n";
import { displayCombo } from "@/lib/shortcuts";
import { canvasTitleTaken, useAppStore } from "@/store/appStore";
import { shortcutOf } from "@/store/settingsStore";
import type { CanvasMeta, ID } from "@/types/model";
import { consumeDragClick, startCanvasDrag } from "./canvasDrag";

const app = () => useAppStore.getState();

function tabMenu(e: ReactMouseEvent, meta: CanvasMeta) {
  const { tabs, closeTabs } = app();
  const id = meta.id;
  const at = tabs.indexOf(id);
  const close = shortcutOf("closeTab");
  openContextMenu(e, [
    { label: t("关闭"), hint: close ? displayCombo(close) : undefined, onSelect: () => closeTabs([id]) },
    { label: t("关闭其他标签页"), disabled: tabs.length < 2, onSelect: () => closeTabs(tabs.filter((x) => x !== id)) },
    { label: t("关闭右侧标签页"), disabled: at === tabs.length - 1, onSelect: () => closeTabs(tabs.slice(at + 1)) },
    { label: t("关闭所有标签页"), onSelect: () => closeTabs(tabs) },
    "separator",
    // 画布卡片菜单里除「打开」以外的条目：重命名、移动到、导出、删除等
    ...canvasMenu(meta).slice(1),
  ]);
}

/** 双击标签页时就地改名 */
function TabTitleEditor({ meta, onDone }: { meta: CanvasMeta; onDone(): void }) {
  const [value, setValue] = useState(meta.title);
  const commit = () => {
    onDone();
    const title = value.trim();
    if (title && title !== meta.title && canvasTitleTaken(meta.projectId, title, meta.id)) {
      app().showToast(t("项目里已经有名为「{name}」的画布", { name: title }));
      return;
    }
    if (title && title !== meta.title) {
      void app()
        .updateCanvas(meta.id, { title })
        .catch((e) => app().showToast(t("重命名失败：{error}", { error: String(e) })));
    }
  };
  return (
    <input
      className="tab-title-input"
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setValue(meta.title);
          onDone();
        }
      }}
    />
  );
}

/** 打开的画布标签页；右端是当前画布的操作。拖动标签页可以把画布移到侧栏的项目或回收站 */
export function TabBar() {
  useT();
  const tabs = useAppStore((s) => s.tabs);
  const view = useAppStore((s) => s.view);
  const canvases = useAppStore((s) => s.canvases);
  const projects = useAppStore((s) => s.projects);
  const [renaming, setRenaming] = useState<ID | null>(null);

  if (tabs.length === 0) return null;
  const activeId = view.kind === "canvas" ? view.canvasId : null;
  const activeMeta = activeId ? canvases.find((c) => c.id === activeId) : undefined;

  // 竖向滚轮也能横向滚动标签栏
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
  };

  return (
    <div className="tabbar">
      <div className="tabbar-tabs" role="tablist" onWheel={onWheel}>
        {tabs.map((id) => {
          const meta = canvases.find((c) => c.id === id);
          if (!meta) return null;
          const project = projects.find((p) => p.id === meta.projectId);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={id === activeId}
              className={`tab${id === activeId ? " is-active" : ""}`}
              title={t("{name}\n双击重命名，拖到侧栏的项目或回收站可移动或删除", { name: meta.title })}
              onPointerDown={(e) => renaming !== id && startCanvasDrag(e, meta)}
              onClick={() => {
                if (!consumeDragClick()) app().navigate({ kind: "canvas", canvasId: id });
              }}
              onDoubleClick={() => setRenaming(id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && app().closeTabs([id])}
              onContextMenu={(e) => tabMenu(e, meta)}
            >
              {project && <ProjectIcon project={project} size={13} />}
              {renaming === id ? (
                <TabTitleEditor meta={meta} onDone={() => setRenaming(null)} />
              ) : (
                <span className="tab-title">{meta.title}</span>
              )}
              <button
                className="tab-close"
                title={t("关闭")}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  app().closeTabs([id]);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {activeMeta && <CanvasActions meta={activeMeta} />}
    </div>
  );
}
