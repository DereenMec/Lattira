import { operationTarget } from "@/lib/operations";
/**
 * 卡片的复制（Ctrl+C）与粘贴（Ctrl+V）。
 *
 * 复制时系统剪贴板里同时放：文件（文件 / 图片卡片的原文件）、纯文本（文本卡片的内容）、
 * 栖页卡片数据。粘贴到微信、资源管理器等应用时用前两种；粘贴回画布时用卡片数据，保留布局、颜色和连线。
 */
import { withDescendants } from "@/lib/folders";
import { boundsOf, type Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { t } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, CanvasElement, Edge, ID } from "@/types/model";
import { resolveIncoming } from "./cardNames";
import { importedMessage, pathsKey, runImport } from "./importing";
import { hostOf, placeLinks, urlsInText } from "./links";
import { assetsInTree, elementsForAssets, elementsForTree, newTextCard } from "./placement";

const app = () => useAppStore.getState();
const canvas = () => useCanvasStore.getState();

interface CopiedCards {
  app: "lattira";
  version: 1;
  elements: CanvasElement[];
  edges: Edge[];
  /** 引用的资源及其绝对路径；粘贴到其他工作区时据此重新导入 */
  assets: (Asset & { absPath: string })[];
  /** 复制自哪个画布的哪一层（parentId 为 null 时是画布上）：粘贴回同一处时重名的自动加「_副本」 */
  source?: { canvasId: ID; parentId: ID | null };
}

/** 选中的卡片（连同文件夹里的内容）打包成粘贴用的数据 */
function packCards(chosen: ID[]): CopiedCards | null {
  const { doc } = canvas();
  if (!doc || chosen.length === 0) return null;
  const ids = withDescendants(doc.elements, chosen);
  const elements = doc.elements.filter((e) => ids.has(e.id));
  const { assets } = app();
  const used = new Map<ID, Asset>();
  for (const el of elements) {
    if (el.type !== "image" && el.type !== "file") continue;
    const a = assets.get(el.assetId);
    if (a) used.set(a.id, a);
  }
  const first = doc.elements.find((e) => e.id === chosen[0]);
  return {
    app: "lattira",
    version: 1,
    elements,
    edges: doc.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId)),
    assets: [...used.values()].map((a) => ({ ...a, absPath: backend.assetPath(a) })),
    source: { canvasId: doc.canvasId, parentId: first?.parentId ?? null },
  };
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/**
 * 复制选中的卡片；选中文件夹时连同里面的内容一起复制。ids 不填时复制画布上选中的。
 * cut 为 true 时是剪切：复制成功后把它们从画布（或文件夹）中删除，可以撤销。
 */
export async function copySelection(selected?: ID[], opts: { cut?: boolean } = {}): Promise<void> {
  const operation = operationTarget();
  const { doc, selectedIds } = canvas();
  const chosen = selected ?? selectedIds;
  const cards = packCards(chosen);
  if (!doc || !cards) return;
  const texts = cards.elements.flatMap((el) =>
    el.type === "text" && el.text.trim()
      ? [{ name: firstLine(el.text).slice(0, 40) || t("文本"), text: el.text }]
      : el.type === "link"
        ? [{ name: (el.title || hostOf(el.url)).slice(0, 40), text: el.url }]
        : [],
  );
  try {
    await backend.copyCards({
      assetIds: cards.assets.map((a) => a.id),
      texts,
      plainText: texts.map((t) => t.text).join("\n\n"),
      cards: JSON.stringify(cards),
    });
  } catch (e) {
    const error = String(e);
    app().showToast(opts.cut ? t("剪切失败：{error}", { error }) : t("复制失败：{error}", { error }));
    return;
  }
  if (opts.cut) {
    // 复制期间画布可能已经切换，只删除仍在当前画布上的
    if (operation.valid()) canvas().deleteElements(chosen);
    app().showToast(t("已剪切 {n} 张卡片", { n: chosen.length }));
  } else {
    app().showToast(t("已复制 {n} 张卡片", { n: chosen.length }));
  }
}

/** 剪切：复制后删除，粘贴时（包括粘贴到文件夹里）生成新的卡片 */
export const cutSelection = (selected?: ID[]) => copySelection(selected, { cut: true });

function parseCards(raw: string | null): CopiedCards | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as CopiedCards;
    return data.app === "lattira" && Array.isArray(data.elements) ? data : null;
  } catch {
    return null;
  }
}

/**
 * 粘贴复制来的卡片：整体以 at 为中心放置，生成新 id；当前工作区没有的文件会重新导入。
 * parentId 不为空时放进那个文件夹。同一层里重名时：粘贴回复制时的那一层（就地复制）自动加「_副本」，
 * 其他位置要求改名（见 cardNames.ts）。返回最外层的那些新卡片
 */
async function pasteCards(data: CopiedCards, at: Point, parentId?: ID): Promise<ID[]> {
  const operation = operationTarget(parentId);
  const doc = canvas().doc;
  const inPlace = !!data.source && data.source.canvasId === doc?.canvasId && (data.source.parentId ?? undefined) === parentId;
  const { assets } = app();
  const remap = new Map<ID, ID>();
  const missing = data.assets.filter((a) => !assets.has(a.id) && a.absPath);
  if (missing.length > 0 && backend.kind === "tauri") {
    const paths = missing.map((a) => a.absPath);
    const imported = await runImport((task) => backend.importPaths(paths, task), { key: pathsKey(paths) });
    if (!imported || !operation.valid()) return [];
    app().addAssets(imported);
    missing.forEach((a, i) => remap.set(a.id, imported[i].id));
  }
  const known = app().assets;
  const usable = data.elements.filter(
    (el) => (el.type !== "image" && el.type !== "file") || known.has(remap.get(el.assetId) ?? el.assetId),
  );
  // 复制的文件夹里的内容跟着文件夹走，只有直接放在画布上的那些按位置摆放
  const copied = new Set(usable.map((el) => el.id));
  const isTop = (el: CanvasElement) => !el.parentId || !copied.has(el.parentId);
  const b = boundsOf(usable.filter(isTop));
  if (!b) return [];
  const dx = at.x - (b.x + b.width / 2);
  const dy = at.y - (b.y + b.height / 2);
  const now = Date.now();
  const ids = new Map<ID, ID>();
  for (const el of usable) ids.set(el.id, uuidv7());
  const fresh = usable.map((el) => {
    const top = isTop(el);
    const moved = {
      ...el,
      id: ids.get(el.id)!,
      x: top ? el.x + dx : el.x,
      y: top ? el.y + dy : el.y,
      parentId: top ? parentId : ids.get(el.parentId!),
      createdAt: now,
      updatedAt: now,
    };
    return "assetId" in moved ? { ...moved, assetId: remap.get(moved.assetId) ?? moved.assetId } : moved;
  }) as CanvasElement[];
  const elements = await resolveIncoming(fresh, parentId, inPlace ? "copy" : "ask");
  const kept = new Set(elements.map((el) => el.id));
  const edges = data.edges
    .map((e) => ({ ...e, id: uuidv7(), fromId: ids.get(e.fromId)!, toId: ids.get(e.toId)! }))
    .filter((e) => kept.has(e.fromId) && kept.has(e.toId));
  if (!operation.valid()) return [];
  canvas().insertCards(elements, edges);
  return elements.filter((el) => (el.parentId ?? undefined) === parentId).map((el) => el.id);
}

/** 创建副本（Ctrl+D）：在原处稍微错开放一份，重名的文件、文件夹自动加「_副本」，文件复制成独立的一份 */
export async function duplicateCards(chosen: ID[]): Promise<void> {
  const doc = canvas().doc;
  const data = packCards(chosen);
  if (!doc || !data) return;
  const top = data.elements.filter((el) => chosen.includes(el.id));
  const b = boundsOf(top);
  if (!b) return;
  const parentId = data.source?.parentId ?? undefined;
  try {
    const ids = await pasteCards(data, { x: b.x + b.width / 2 + 32, y: b.y + b.height / 2 + 32 }, parentId);
    if (parentId) canvas().showInOpenFolder(parentId, ids);
  } catch (e) {
    app().showToast(t("创建副本失败：{error}", { error: String(e) }));
  }
}

/**
 * 粘贴到画布：依次尝试栖页卡片 → 剪贴板中的文件（如资源管理器里复制的）→
 * 浏览器给出的文件（如截图）→ 纯文本（只有网址时变成链接卡片）。fallback 需在 paste 事件中同步读取。
 * parentId 不为空时粘贴到那个文件夹里（at 只用于保存位置）。返回粘贴出来的最外层元素
 */
export async function pasteIntoCanvas(at: Point, fallback: { files: File[]; text: string }, parentId?: ID): Promise<ID[]> {
  const operation = operationTarget(parentId);
  // 导入、粘贴进来的文件和文件夹与这一层已有的重名时要求改名
  const add = async (incoming: CanvasElement[]) => {
    const elements = await resolveIncoming(incoming, parentId, "ask");
    if (!operation.valid()) return [];
    canvas().addElements(elements, { select: !parentId });
    return elements.filter((el) => el.parentId === parentId).map((el) => el.id);
  };
  const into = (elements: CanvasElement[]) => (parentId ? elements.map((el) => ({ ...el, parentId })) : elements);
  try {
    const clip = await backend.readClipboard().catch(() => null);
    if (!operation.valid()) return [];
    const cards = parseCards(clip?.cards ?? null);
    if (cards) return await pasteCards(cards, at, parentId);

    // 资源管理器中复制的文件和文件夹：文件夹变成文件夹卡片
    if (clip?.files.length) {
      const files = clip.files;
      const nodes = await runImport((task) => backend.importTree(files, task), {
        key: pathsKey(files),
        done: (n) => importedMessage(assetsInTree(n).length),
      });
      if (!nodes || !operation.valid()) return [];
      app().addAssets(assetsInTree(nodes));
      return await add(elementsForTree(nodes, at, parentId));
    }
    let imported: Asset[] = [];
    if (fallback.files.length) {
      imported = (await runImport((task) => backend.importBlobs(fallback.files, task), { done: (a) => importedMessage(a.length) })) ?? [];
    }
    if (!operation.valid()) return [];
    if (imported.length) {
      app().addAssets(imported);
      return await add(into(elementsForAssets(imported, at)));
    }

    const text = fallback.text || clip?.text || "";
    const urls = urlsInText(text);
    if (urls.length) return placeLinks(urls, at, parentId).map((el) => el.id);
    if (text.trim()) return await add(into([newTextCard(at, text)]));
  } catch (e) {
    app().showToast(t("粘贴失败：{error}", { error: String(e) }));
  }
  return [];
}
