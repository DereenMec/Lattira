import { useEffect } from "react";
import { AssetLibrary } from "@/features/assets/AssetLibrary";
import { CalendarView } from "@/features/calendar/CalendarView";
import { CanvasPage } from "@/features/canvas/CanvasPage";
import { CanvasDragGhost } from "@/features/layout/canvasDrag";
import { ErrorBoundary } from "@/features/layout/ErrorBoundary";
import { ContextMenuHost, useSuppressNativeMenu } from "@/features/menu/ContextMenu";
import { PromptHost } from "@/features/menu/PromptDialog";
import { ProjectStyleDialog } from "@/features/project/ProjectStyleDialog";
import { Sidebar } from "@/features/layout/Sidebar";
import { TabBar } from "@/features/layout/TabBar";
import { ProjectView } from "@/features/project/ProjectView";
import { RecentView } from "@/features/project/RecentView";
import { SearchPalette } from "@/features/search/SearchPalette";
import { SettingsView } from "@/features/settings/SettingsView";
import { TrashView } from "@/features/trash/TrashView";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { t, useLocale } from "@/i18n";
import { handleQuit, setCloseToTray, setGlobalShortcut, syncTrayLabels } from "@/services/desktop";
import { checkForUpdates } from "@/services/updater";
import { inboxOf, useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { commandForEvent, shortcutOf, useSettings } from "@/store/settingsStore";
import type { CommandId } from "@/lib/shortcuts";

/** 资源库页面不用全局搜索，改为聚焦资源库自己的搜索框 */
function focusAssetSearch() {
  const input = document.querySelector<HTMLInputElement>("[data-asset-search]");
  input?.focus();
  input?.select();
}

function runCommand(id: CommandId) {
  const s = useAppStore.getState();
  const v = s.view;
  const currentProject =
    v.kind === "project" ? v.projectId : v.kind === "canvas" ? s.canvases.find((c) => c.id === v.canvasId)?.projectId : undefined;
  switch (id) {
    case "search":
      if (v.kind === "assets") focusAssetSearch();
      else s.setSearchOpen(!s.searchOpen);
      break;
    case "newCanvas": {
      const projectId = currentProject ?? inboxOf(s.projects)?.id;
      if (projectId) void s.createCanvas(projectId).catch((e) => s.showToast(t("新建画布失败：{error}", { error: String(e) })));
      break;
    }
    case "recent":
      s.navigate({ kind: "recent" });
      break;
    case "inbox": {
      const inbox = inboxOf(s.projects);
      if (inbox) s.navigate({ kind: "project", projectId: inbox.id });
      break;
    }
    case "trash":
      s.navigate({ kind: "trash" });
      break;
    case "openProject":
      if (currentProject) s.navigate({ kind: "project", projectId: currentProject });
      break;
    case "calendar":
      s.navigate({ kind: "calendar" });
      break;
    case "assets":
      s.navigate({ kind: "assets" });
      break;
    case "settings":
      s.navigate({ kind: "settings" });
      break;
    case "closeTab":
      if (v.kind === "canvas") s.closeTabs([v.canvasId]);
      break;
    case "nextTab":
      s.cycleTab(1);
      break;
    case "prevTab":
      s.cycleTab(-1);
      break;
    case "showWindow":
      break;
  }
}

/** 启动时把设置同步给桌面端：托盘行为、全局快捷键、托盘菜单文字；托盘退出前先写盘 */
function useDesktopSync() {
  const locale = useLocale((s) => s.locale);
  useEffect(() => {
    const settings = useSettings.getState();
    void setCloseToTray(settings.closeToTray).catch(() => {});
    void setGlobalShortcut(shortcutOf("showWindow")).catch((e) =>
      useAppStore.getState().showToast(t("呼出主界面的快捷键注册失败：{error}", { error: String(e) })),
    );
    // 启动一会儿后在后台检查更新，失败时不提示
    const timer = settings.autoCheckUpdates
      ? window.setTimeout(() => {
          void checkForUpdates(true).then((s) => {
            if (s.kind === "available") {
              useAppStore.getState().showToast(t("发现新版本 v{version}，可在 设置 → 关于 中更新", { version: s.version }));
            }
          });
        }, 5000)
      : undefined;
    const stopQuit = handleQuit(() => useCanvasStore.getState().flush());
    return () => {
      window.clearTimeout(timer);
      stopQuit();
    };
  }, []);
  useEffect(() => {
    void syncTrayLabels().catch(() => {});
  }, [locale]);
}

export function App() {
  const status = useAppStore((s) => s.status);
  const view = useAppStore((s) => s.view);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const toast = useAppStore((s) => s.toast);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);

  useSuppressNativeMenu();
  useDesktopSync();

  useEffect(() => {
    void useAppStore.getState().init();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (s.status !== "ready" || useSettings.getState().capturing) return;
      // Ctrl+F：画布页由 CanvasView 打开画布内查找，资源库聚焦自己的搜索框，其他页面打开全局搜索
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyF") {
        e.preventDefault();
        if (s.view.kind === "assets") focusAssetSearch();
        else if (s.view.kind !== "canvas" && !s.searchOpen) s.setSearchOpen(true);
        return;
      }
      const command = commandForEvent(e);
      if (!command) return;
      e.preventDefault();
      runCommand(command);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (status === "loading") return <div className="boot" />;

  return (
    <>
      {status === "no-workspace" ? (
        <WelcomeScreen />
      ) : (
        <div className="shell" style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}>
          <Sidebar />
          <main className="main">
            <TabBar />
            <ErrorBoundary resetKey={JSON.stringify(view)}>
              {view.kind === "canvas" && (
                <CanvasPage
                  key={view.canvasId}
                  canvasId={view.canvasId}
                  focusElementId={view.focusElementId}
                  focusAssetId={view.focusAssetId}
                />
              )}
              {view.kind === "recent" && <RecentView />}
              {view.kind === "project" && <ProjectView projectId={view.projectId} />}
              {view.kind === "calendar" && <CalendarView />}
              {view.kind === "assets" && <AssetLibrary />}
              {view.kind === "trash" && <TrashView />}
              {view.kind === "settings" && <SettingsView section={view.section} />}
            </ErrorBoundary>
          </main>
        </div>
      )}
      {searchOpen && <SearchPalette />}
      {toast && <div className="toast">{toast}</div>}
      <CanvasDragGhost />
      <ContextMenuHost />
      <PromptHost />
      <ProjectStyleDialog />
    </>
  );
}
