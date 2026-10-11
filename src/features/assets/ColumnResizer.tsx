import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/i18n";
import { clampColumnWidth, COLUMN_SIZES, type ResizableAssetColumn } from "./assetColumns";

interface Props {
  column: ResizableAssetColumn;
  label: string;
  width: number;
  onResize(width: number, persist: boolean): void;
}

/** 捕获指针，让拖出表头、触摸取消及切换视图都能正确结束调整。 */
export function ColumnResizer({ column, label, width, onResize }: Props) {
  const t = useT();
  const drag = useRef<{ pointerId: number; x: number; width: number; latest: number } | null>(null);
  useEffect(() => () => {
    if (drag.current) document.body.classList.remove("is-resizing");
  }, []);

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = null;
    document.body.classList.remove("is-resizing");
    onResize(current.latest, true);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="asset-col-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("调整「{name}」列宽", { name: label })}
      aria-valuemin={COLUMN_SIZES[column].min}
      aria-valuemax={COLUMN_SIZES[column].max}
      aria-valuenow={width}
      title={t("拖动调整宽度，双击恢复默认")}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onResize(COLUMN_SIZES[column].default, true);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0 || drag.current) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, x: e.clientX, width, latest: width };
        document.body.classList.add("is-resizing");
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || current.pointerId !== e.pointerId) return;
        current.latest = clampColumnWidth(column, current.width + e.clientX - current.x);
        onResize(current.latest, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const current = drag.current;
        if (e.key === "Escape" && current) {
          e.stopPropagation();
          e.preventDefault();
          drag.current = null;
          document.body.classList.remove("is-resizing");
          onResize(current.width, true);
          if (e.currentTarget.hasPointerCapture(current.pointerId)) e.currentTarget.releasePointerCapture(current.pointerId);
          return;
        }
        if (current) return;
        if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.stopPropagation();
          e.preventDefault();
          onResize(clampColumnWidth(column, width + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 50 : 10)), true);
        }
      }}
    />
  );
}
