/**
 * 同一层（画布上一层，或同一个文件夹里）的文件、图片、文件夹卡片不能重名，与 Windows 资源管理器一致：
 * - 就地复制（复制后粘贴回原处、创建副本）：自动改名为「名字_副本」「名字_副本 (2)」
 * - 粘贴、导入、移动到别处时重名：弹框要求改名，取消则跳过这一项
 * - 改名时不能改成这一层里已有的名字；新文件夹自动用「新文件夹 (2)」
 * 文本、链接卡片没有名字，不受限制。比较名字时不区分大小写。
 */
import { promptText } from "@/features/menu/PromptDialog";
import { t } from "@/i18n";
import { canMoveInto, cardName as cardNameOf, namesAt as namesAtOf, withDescendants } from "@/lib/folders";
import { nameKey, sanitizeName, sanitizeFileName, splitName, uniqueName } from "@/lib/names";
import { operationTarget } from "@/lib/operations";
import type { Point } from "@/lib/geometry";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore, type ElementPatch } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID } from "@/types/model";

const app = () => useAppStore.getState();
const canvas = () => useCanvasStore.getState();

export const cardName = (el: CanvasElement) => cardNameOf(el, app().assets, t("未命名文件夹"));

const isFileCard = (el: CanvasElement) => el.type === "file" || el.type === "image";

/** 当前画布 parentId 这一层已有的名字（nameKey 形式），exclude 中的卡片不算 */
export function namesAt(parentId: ID | undefined, exclude?: ReadonlySet<ID>, elements = canvas().doc?.elements ?? []): Set<string> {
  return namesAtOf(elements, parentId, app().assets, t("未命名文件夹"), exclude);
}

/** 新文件夹的默认名：「新文件夹」，已有时「新文件夹 (2)」 */
export function newFolderLabel(parentId?: ID): string {
  return uniqueName(t("新文件夹"), namesAt(parentId));
}

/** 文件名没写扩展名时沿用原来的（与后台改名的规则一致），用来检查重名 */
export function withExt(name: string, original: string): string {
  return sanitizeFileName(splitName(name, true)[1] ? name.trim() : `${name.trim()}${splitName(original, true)[1]}`);
}

/** 改名检查：name 在 taken 里时返回提示文字 */
export function nameError(name: string, taken: ReadonlySet<string>): string | null {
  return taken.has(nameKey(name)) ? t("此位置已有名为「{name}」的文件或文件夹", { name: name.trim() }) : null;
}

/**
 * 文件卡片要用新名字：文件只有这张卡片在用时直接改名；还被别处（其他卡片、其他画布）用着，或 copy 为 true 时，
 * 复制一份独立的文件，别处不受影响
 */
async function assetNamed(asset: Asset, name: string, cardId: ID, copy: boolean): Promise<Asset> {
  // An immutable original makes rename undoable and protects unsaved/trash references.
  void cardId; void copy;
  const result = await backend.copyAssetAs(asset.id, name);
  return result;
}

export interface NamePlan {
  /** 改了名的卡片：文件夹的新名字，或文件卡片改用的资源 */
  patches: Record<ID, ElementPatch>;
  /** 用户选择跳过的卡片 */
  skipped: Set<ID>;
  copies: { cardId: ID; asset: Asset; name: string }[];
  valid(): boolean;
}

async function applyNames(plan: NamePlan): Promise<void> {
  for (const item of plan.copies) {
    if (!plan.valid()) throw new Error(t("操作已取消"));
    const named = await assetNamed(item.asset, item.name, item.cardId, true);
    if (!plan.valid()) throw new Error(t("操作已取消"));
    app().addAssets([named]);
    plan.patches[item.cardId] = { assetId: named.id };
  }
}

/**
 * 卡片放进 parentId 这一层之前处理重名。items 是要放进去的卡片（只看文件、图片、文件夹卡片），
 * mode 为 copy 时自动加「_副本」，ask 时逐个弹框改名。exclude：这一层里会被移走、不再占名字的卡片
 */
export async function planNames(
  items: CanvasElement[],
  parentId: ID | undefined,
  mode: "copy" | "ask",
  exclude: ReadonlySet<ID> = new Set(),
  elements?: CanvasElement[],
): Promise<NamePlan> {
  const target = operationTarget();
  const plan: NamePlan = { patches: {}, skipped: new Set(), copies: [], valid: target.valid };
  const taken = namesAt(parentId, new Set([...exclude, ...items.map((i) => i.id)]), elements);
  for (const el of items) {
    const name = cardName(el);
    if (name === null) continue;
    if (!taken.has(nameKey(name))) {
      taken.add(nameKey(name));
      continue;
    }
    const file = isFileCard(el);
    const kind = file ? t("文件") : t("文件夹");
    const newName =
      mode === "copy"
        ? uniqueName(name, taken, { ext: file, style: "copy", suffix: t("_副本") })
        : await promptText(t("重命名{kind}", { kind }), uniqueName(name, taken, { ext: file }), {
            message: t("此位置已有名为「{name}」的{kind}，请换一个名字；跳过则不放入这一项。", { name, kind }),
            selectStem: file,
            cancelLabel: t("跳过"),
            validate: (v) => nameError(file ? withExt(v, name) : sanitizeName(v), taken),
          });
    if (!target.valid()) throw new Error(t("操作已取消"));
    if (newName === null) {
      plan.skipped.add(el.id);
      continue;
    }
    try {
      if (file && "assetId" in el) {
        const asset = app().assets.get(el.assetId);
        if (!asset) throw new Error(t("找不到这个文件"));
        const normalized = withExt(newName, name);
        plan.copies.push({ cardId: el.id, asset, name: normalized });
        taken.add(nameKey(normalized));
      } else {
        plan.patches[el.id] = { label: sanitizeName(newName) };
        taken.add(nameKey(sanitizeName(newName)));
      }
    } catch (e) {
      app().showToast(t("重命名失败：{error}", { error: String(e) }));
      plan.skipped.add(el.id);
    }
  }
  return plan;
}

/**
 * 导入、粘贴得到的一批新元素（parentId 为 target 的是放在这一层的，其余在它们里面）：处理重名，
 * 去掉跳过的（连同里面的内容），返回可以加进画布的元素
 */
export async function resolveIncoming(
  elements: CanvasElement[],
  target: ID | undefined,
  mode: "copy" | "ask",
): Promise<CanvasElement[]> {
  const patches: Record<ID, ElementPatch> = {};
  const skipped = new Set<ID>();
  const plans: NamePlan[] = [];
  const levels = new Set([target, ...elements.filter((e) => e.type === "folder").map((e) => e.id)]);
  for (const level of levels) {
    const items = elements.filter((e) => e.parentId === level);
    const plan = await planNames(items, level, mode, new Set(), [...(canvas().doc?.elements ?? []), ...elements]);
    plans.push(plan);
    for (const id of plan.skipped) skipped.add(id);
  }
  const dropped = withDescendants(elements, skipped);
  for (const plan of plans) {
    plan.copies = plan.copies.filter((c) => !dropped.has(c.cardId));
    await applyNames(plan);
    Object.assign(patches, plan.patches);
  }
  if (skipped.size) app().showToast(t("已跳过 {n} 项", { n: skipped.size }));
  return elements.filter((e) => !dropped.has(e.id)).map((e) => (patches[e.id] ? ({ ...e, ...patches[e.id] } as CanvasElement) : e));
}

/** 放进文件夹（拖进文件夹、移到文件夹）；重名时要求改名，跳过的不移动。有东西移进去时返回 true */
export async function moveIntoFolderNamed(ids: ID[], folderId: ID): Promise<boolean> {
  const doc = canvas().doc;
  if (!doc || !canMoveInto(doc.elements, ids, folderId)) return false;
  const items = doc.elements.filter((e) => ids.includes(e.id) && e.parentId !== folderId);
  const plan = await planNames(items, folderId, "ask");
  await applyNames(plan);
  const moving = ids.filter((id) => !plan.skipped.has(id));
  return moving.length > 0 && canvas().moveIntoFolder(moving, folderId, plan.patches);
}

/** 从文件夹拿到画布上；重名时要求改名，跳过的留在文件夹里 */
export async function moveToCanvasNamed(ids: ID[], at: Point): Promise<void> {
  const doc = canvas().doc;
  if (!doc) return;
  const items = doc.elements.filter((e) => ids.includes(e.id) && e.parentId);
  const plan = await planNames(items, undefined, "ask");
  await applyNames(plan);
  const moving = items.map((e) => e.id).filter((id) => !plan.skipped.has(id));
  if (moving.length) canvas().moveToCanvas(moving, at, plan.patches);
}

/** 解散文件夹：里面的内容和外面重名时要求改名；有一项跳过就不解散 */
export async function dissolveFolderNamed(folderId: ID): Promise<void> {
  const doc = canvas().doc;
  const folder = doc?.elements.find((e) => e.id === folderId);
  if (!doc || !folder) return;
  const inside = doc.elements.filter((e) => e.parentId === folderId);
  const plan = await planNames(inside, folder.parentId, "ask", new Set([folderId]));
  if (plan.skipped.size) {
    app().showToast(t("有重名的内容没有改名，文件夹没有解散"));
    return;
  }
  await applyNames(plan);
  canvas().dissolveFolder(folderId, plan.patches);
}

/** 文件夹卡片改名的检查（画布上原地改名、重命名对话框） */
export function folderRenameError(folder: CanvasElement, label: string): string | null {
  return nameError(sanitizeName(label.trim() || t("未命名文件夹")), namesAt(folder.parentId, new Set([folder.id])));
}
