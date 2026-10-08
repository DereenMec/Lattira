import { useEffect } from "react";
import { AboutDialog } from "@/features/about/AboutDialog";
import { AssetLibrary } from "@/features/assets/AssetLibrary";
import { CalendarView } from "@/features/calendar/CalendarView";
import { CanvasPage } from "@/features/canvas/CanvasPage";
import { CanvasDragGhost } from "@/features/layout/canvasDrag";
import { ErrorBoundary } from "@/features/layout/ErrorBoundary";
import { ContextMenuHost, useSuppressNativeMenu } from "@/features/menu/ContextMenu";
import { PromptHost } from "@/features/menu/PromptDialog";
import { ProjectStyleDialog } from "@/features/project/ProjectStyleDialog";
import { Sidebar } from "@/features/layout/Sidebar";
import { ProjectView } from "@/features/project/ProjectView";
import { RecentView } from "@/features/project/RecentView";
import { SearchPalette } from "@/features/search/SearchPalette";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { useAppStore } from "@/store/appStore";

export function App() {
  const status = useAppStore((s) => s.status);
  const view = useAppStore((s) => s.view);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const toast = useAppStore((s) => s.toast);

  useSuppressNativeMenu();

  useEffect(() => {
    void useAppStore.getState().init();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (s.status !== "ready" || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if ((key === "f" || key === "e") && s.view.kind === "assets") {
        // 资源库页面不用全局搜索，改为聚焦资源库自己的搜索框
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-asset-search]");
        input?.focus();
        input?.select();
      } else if (key === "f") {
        // 不用浏览器自带的网页查找；画布页由 CanvasView 打开画布内查找，其他页面打开全局搜索
        e.preventDefault();
        if (s.view.kind !== "canvas" && !s.searchOpen) s.setSearchOpen(true);
      } else if (key === "e") {
        e.preventDefault();
        s.setSearchOpen(!s.searchOpen);
      } else if (key === "1" && !e.shiftKey) {
        const v = s.view;
        const current = v.kind === "canvas" ? s.canvases.find((c) => c.id === v.canvasId)?.projectId : undefined;
        const inbox = s.projects.find((p) => p.isInbox);
        const projectId = current ?? inbox?.id;
        if (projectId) s.navigate({ kind: "project", projectId });
      } else if (key === "2") {
        e.preventDefault();
        s.navigate({ kind: "calendar" });
      } else if (key === "3") {
        e.preventDefault();
        s.navigate({ kind: "assets" });
      }
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
        <div className="shell">
          <Sidebar />
          <main className="main">
            <ErrorBoundary resetKey={JSON.stringify(view)}>
              {view.kind === "canvas" && (
                <CanvasPage canvasId={view.canvasId} focusElementId={view.focusElementId} focusAssetId={view.focusAssetId} />
              )}
              {view.kind === "recent" && <RecentView />}
              {view.kind === "project" && <ProjectView projectId={view.projectId} />}
              {view.kind === "calendar" && <CalendarView />}
              {view.kind === "assets" && <AssetLibrary />}
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
      <AboutDialog />
    </>
  );
}
