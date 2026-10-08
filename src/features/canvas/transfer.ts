/** 画布的导出与导入（画布包 .zip 或 JSON Canvas 文件），见 src-tauri/src/transfer.rs */
import { t } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { reindexCanvas, useCanvasStore } from "@/store/canvasStore";
import type { CanvasMeta, ID } from "@/types/model";

export async function exportCanvas(canvas: CanvasMeta) {
  const app = useAppStore.getState();
  try {
    // 正在编辑的画布先写盘，导出的才是最新内容
    const editing = useCanvasStore.getState();
    if (editing.doc?.canvasId === canvas.id) await editing.flush();
    if (await backend.exportCanvas(canvas)) app.showToast(t("已导出「{name}」", { name: canvas.title }));
  } catch (e) {
    app.showToast(t("导出失败：{error}", { error: String(e) }));
  }
}

/** 导入到项目；只导入了一个画布时直接打开它 */
export async function importCanvases(projectId: ID) {
  const app = useAppStore.getState();
  try {
    const imported = await backend.importCanvases(projectId);
    if (imported.length === 0) return;
    await app.refreshAssets();
    const metas: CanvasMeta[] = [];
    for (const meta of imported) metas.push(await reindexCanvas(meta.id).catch(() => meta));
    useAppStore.setState((s) => ({ canvases: [...s.canvases, ...metas] }));
    await app.refreshAssets();
    if (metas.length === 1) app.navigate({ kind: "canvas", canvasId: metas[0].id });
    else app.navigate({ kind: "project", projectId });
    app.showToast(t("已导入 {n} 个画布", { n: metas.length }));
  } catch (e) {
    app.showToast(t("导入失败：{error}", { error: String(e) }));
  }
}
