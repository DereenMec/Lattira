import { FileInput, Plus } from "lucide-react";
import { importCanvases } from "@/features/canvas/transfer";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/appStore";
import type { ID } from "@/types/model";

/**
 * 画布列表页（最近、项目）页头共用的按钮：导入画布、新建画布。
 * 给画布列表加新操作时加在这里，两个页面会同时有。
 */
export function CanvasListActions({ projectId, intoInbox }: { projectId: ID; intoInbox?: boolean }) {
  const t = useT();
  const where = intoInbox ? t("（放在「未分类」里）") : "";
  return (
    <>
      <button
        className="btn ghost"
        onClick={() => void importCanvases(projectId)}
        title={t("导入画布包（.zip）或 JSON Canvas 文件（.canvas）") + where}
      >
        <FileInput size={14} /> {t("导入")}
      </button>
      <button
        className="btn primary"
        onClick={() => void useAppStore.getState().createCanvas(projectId)}
        title={intoInbox ? t("新画布放在「未分类」里") : undefined}
      >
        <Plus size={14} /> {t("新建画布")}
      </button>
    </>
  );
}
