import { FileOutput, PanelRight, Trash2 } from "lucide-react";
import { Splitter } from "@/features/layout/Splitter";
import { confirmAction } from "@/services/confirm";
import { msg, useT } from "@/i18n";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasMeta, ID } from "@/types/model";
import { CanvasView } from "./CanvasView";
import { Inspector } from "./Inspector";
import { TextEditorDialog } from "./TextEditorDialog";
import { exportCanvas } from "./transfer";

const SAVE_LABEL = { saved: msg("已保存"), pending: msg("编辑中…"), saving: msg("保存中…"), error: msg("保存失败") } as const;

/** 当前画布的操作，放在标签栏右端（画布页不再单独占一行顶栏） */
export function CanvasActions({ meta }: { meta: CanvasMeta }) {
  const t = useT();
  const inspectorOpen = useAppStore((s) => s.inspectorOpen);
  const saveState = useCanvasStore((s) => s.saveState);

  const remove = async () => {
    if (!(await confirmAction(t("删除画布「{name}」？之后可以在回收站中恢复。", { name: meta.title })))) return;
    await useAppStore.getState().deleteCanvas(meta.id);
  };

  return (
    <div className="tabbar-actions">
      <span className={`save-state is-${saveState}`}>{t(SAVE_LABEL[saveState])}</span>
      {saveState === "error" && <>
        <button className="btn ghost" onClick={() => void useCanvasStore.getState().flush().catch(() => {})}>{t("重试")}</button>
        <button className="btn ghost" onClick={() => void useCanvasStore.getState().recover().catch((e) => useAppStore.getState().showToast(String(e)))}>{t("另存并重新打开")}</button>
      </>}
      <button className="icon-btn" onClick={() => void exportCanvas(meta)} title={t("导出画布（含引用的文件）")}>
        <FileOutput size={15} />
      </button>
      <button className="icon-btn" onClick={() => void remove()} title={t("删除画布")}>
        <Trash2 size={15} />
      </button>
      <button
        className={`icon-btn${inspectorOpen ? " is-on" : ""}`}
        onClick={() => useAppStore.getState().toggleInspector()}
        title={t("显示 / 隐藏检查器")}
      >
        <PanelRight size={15} />
      </button>
    </div>
  );
}

export function CanvasPage({
  canvasId,
  focusElementId,
  focusAssetId,
  findQuery,
}: {
  canvasId: ID;
  focusElementId?: ID;
  focusAssetId?: ID;
  findQuery?: string;
}) {
  const t = useT();
  const meta = useAppStore((s) => s.canvases.find((c) => c.id === canvasId));
  const inspectorOpen = useAppStore((s) => s.inspectorOpen);

  if (!meta) return <div className="empty-page">{t("画布不存在或已被删除。")}</div>;

  return (
    <div className="page canvas-page">
      <div className="canvas-body">
        <CanvasView canvasId={canvasId} focusElementId={focusElementId} focusAssetId={focusAssetId} findQuery={findQuery} />
        {inspectorOpen && (
          <>
            <Splitter panel="inspector" edge="left" />
            <Inspector meta={meta} />
          </>
        )}
      </div>
      <TextEditorDialog />
    </div>
  );
}
