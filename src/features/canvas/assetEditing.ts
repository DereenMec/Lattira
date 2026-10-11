/**
 * 复制出来的文件是独立的（与 Windows 资源管理器一致）：同一个文件被多张卡片、多个画布用着时，工作区里起初只存一份；
 * 从某张卡片打开（编辑）或重命名它时，先给这张卡片复制一份，卡片改用副本，之后的修改不影响其他卡片和画布。
 *
 * 只有这张卡片在用的文件不会复制。不针对某张卡片时（检查器里按文件列出的清单），这个画布上用它的卡片一起改用副本，
 * 只在其他画布也用着时才复制。资源库不属于任何画布，从那里打开、重命名的是原来那份。
 */
import { t } from "@/i18n";
import { operationTarget } from "@/lib/operations";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, ID } from "@/types/model";

/**
 * 卡片 cardId（不给时为这个画布）自己的那份文件：被别处共用时复制一份，卡片改指向副本
 * （不进撤销历史，撤销其他操作时也不会指回去）
 */
export async function ownAssetForCanvas(asset: Asset, cardId?: ID): Promise<Asset> {
  const target = operationTarget();
  const s = useCanvasStore.getState();
  const doc = s.doc;
  if (!doc) return asset;
  const users = doc.elements.filter((el) => "assetId" in el && el.assetId === asset.id);
  const sharedHere = !!cardId && users.some((el) => el.id !== cardId);
  await s.flush();
  if (!target.valid()) throw new Error(t("操作已取消"));
  const own = await backend.forkAssetForCanvas(asset.id, doc.canvasId, sharedHere);
  if (!target.valid()) throw new Error(t("操作已取消"));
  if (own.id === asset.id) return asset;
  useAppStore.getState().addAssets([own]);
  const repoint = cardId ? users.filter((el) => el.id === cardId) : users;
  await s.patchQuietly(doc.canvasId, Object.fromEntries(repoint.map((el) => [el.id, { assetId: own.id }])));
  useAppStore
    .getState()
    .showToast(t("「{name}」还有其他卡片在用，已为这里单独复制一份，在这里修改不会影响其他地方", { name: asset.name }));
  return own;
}

/** 从画布上（卡片、文件夹窗口、检查器）用默认程序打开文件；cardId 是从哪张卡片打开的 */
export async function openFromCanvas(asset: Asset, cardId?: ID): Promise<void> {
  try {
    await backend.openAsset(await ownAssetForCanvas(asset, cardId));
  } catch (e) {
    useAppStore.getState().showToast(t("无法打开文件：{error}", { error: String(e) }));
  }
}
