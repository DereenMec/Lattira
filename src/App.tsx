import { useEffect } from "react";
import { AssetLibrary } from "@/features/assets/AssetLibrary";
import { CalendarView } from "@/features/calendar/CalendarView";
import { CanvasPage } from "@/features/canvas/CanvasPage";
import { Sidebar } from "@/features/layout/Sidebar";
import { ProjectView } from "@/features/project/ProjectView";
import { SearchPalette } from "@/features/search/SearchPalette";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { useAppStore } from "@/store/appStore";

export function App() {
  const status = useAppStore((s) => s.status);
  const view = useAppStore((s) => s.view);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const toast = useAppStore((s) => s.toast);

  useEffect(() => {
    void useAppStore.getState().init();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (s.status !== "ready" || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
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
            {view.kind === "canvas" && <CanvasPage canvasId={view.canvasId} focusElementId={view.focusElementId} />}
            {view.kind === "project" && <ProjectView projectId={view.projectId} />}
            {view.kind === "calendar" && <CalendarView />}
            {view.kind === "assets" && <AssetLibrary />}
          </main>
        </div>
      )}
      {searchOpen && <SearchPalette />}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
