/**
 * 各画布独立：同一个文件放在多个画布上时，工作区里起初只存一份；
 * 在某个画布上打开（编辑）或重命名它时，先给这个画布复制一份，这个画布上引用它的卡片（包括文件夹里的）都改用副本。
 * 之后在这里的修改只影响这个画布，其他画布看到的仍是原来的文件。
 *
 * 只有这个画布在用的文件不会复制。资源库不属于任何画布，从那里打开、重命名的是原来那份。
 */
import { t } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, ID } from "@/types/model";

/** 当前画布用的那份文件：被其他画布共用时复制一份，卡片改指向副本（不进撤销历史，撤销其他操作时也不会指回去） */
export async function ownAssetForCanvas(asset: Asset): Promise<Asset> {
  const s = useCanvasStore.getState();
  const doc = s.doc;
  if (!doc) return asset;
  const own = await backend.forkAssetForCanvas(asset.id, doc.canvasId);
  if (own.id === asset.id) return asset;
  useAppStore.getState().addAssets([own]);
  const patches: Record<ID, { assetId: ID }> = {};
  for (const el of doc.elements) if ("assetId" in el && el.assetId === asset.id) patches[el.id] = { assetId: own.id };
  await s.patchQuietly(doc.canvasId, patches);
  useAppStore
    .getState()
    .showToast(t("「{name}」也在其他画布上，已为这个画布单独复制一份，在这里修改不会影响其他画布", { name: asset.name }));
  return own;
}

/** 从画布上（卡片、文件夹窗口、检查器）用默认程序打开文件 */
export async function openFromCanvas(asset: Asset): Promise<void> {
  try {
    await backend.openAsset(await ownAssetForCanvas(asset));
  } catch (e) {
    useAppStore.getState().showToast(t("无法打开文件：{error}", { error: String(e) }));
  }
}
