import type { PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/i18n";
import { PANEL_WIDTH, useSettings, type Panel } from "@/store/settingsStore";

/**
 * 侧栏边缘的分隔条：拖动调整宽度，双击恢复默认。
 * edge 是分隔条在面板的哪一侧：左侧栏在右边缘（往右拖变宽），检查器在左边缘（往左拖变宽）。
 */
export function Splitter({ panel, edge }: { panel: Panel; edge: "left" | "right" }) {
  const t = useT();
  const width = useSettings((s) => (panel === "sidebar" ? s.sidebarWidth : s.inspectorWidth));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    const widthAt = (x: number) => startWidth + (edge === "right" ? x - startX : startX - x);
    document.body.classList.add("is-resizing");

    const onMove = (ev: PointerEvent) => useSettings.getState().setPanelWidth(panel, widthAt(ev.clientX));
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-resizing");
      useSettings.getState().setPanelWidth(panel, widthAt(ev.clientX), true);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`splitter splitter-${edge}`}
      role="separator"
      aria-orientation="vertical"
      title={t("拖动调整宽度，双击恢复默认")}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useSettings.getState().setPanelWidth(panel, PANEL_WIDTH[panel].default, true)}
    />
  );
}
