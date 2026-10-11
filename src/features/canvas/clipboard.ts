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
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/**
 * 复制选中的卡片；选中文件夹时连同里面的内容一起复制。ids 不填时复制画布上选中的。
 * cut 为 true 时是剪切：复制成功后把它们从画布（或文件夹）中删除，可以撤销。
 */
export async function copySelection(selected?: ID[], opts: { cut?: boolean } = {}): Promise<void> {
  const { doc, selectedIds } = canvas();
  const chosen = selected ?? selectedIds;
  if (!doc || chosen.length === 0) return;
  const ids = withDescendants(doc.elements, chosen);
  const elements = doc.elements.filter((e) => ids.has(e.id));
  const edges = doc.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
  const { assets } = app();
  const used = new Map<ID, Asset>();
  for (const el of elements) {
    if (el.type !== "image" && el.type !== "file") continue;
    const a = assets.get(el.assetId);
    if (a) used.set(a.id, a);
  }
  const texts = elements.flatMap((el) =>
    el.type === "text" && el.text.trim()
      ? [{ name: firstLine(el.text).slice(0, 40) || t("文本"), text: el.text }]
      : el.type === "link"
        ? [{ name: (el.title || hostOf(el.url)).slice(0, 40), text: el.url }]
        : [],
  );
  const cards: CopiedCards = {
    app: "lattira",
    version: 1,
    elements,
    edges,
    assets: [...used.values()].map((a) => ({ ...a, absPath: backend.assetPath(a) })),
  };
  try {
    await backend.copyCards({
      assetIds: [...used.keys()],
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
    if (canvas().doc?.canvasId === doc.canvasId) canvas().deleteElements(chosen);
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
 * parentId 不为空时放进那个文件夹。返回最外层的那些新卡片
 */
async function pasteCards(data: CopiedCards, at: Point, parentId?: ID): Promise<ID[]> {
  const { assets } = app();
  const remap = new Map<ID, ID>();
  const missing = data.assets.filter((a) => !assets.has(a.id) && a.absPath);
  if (missing.length > 0 && backend.kind === "tauri") {
    const paths = missing.map((a) => a.absPath);
    const imported = await runImport((task) => backend.importPaths(paths, task), { key: pathsKey(paths) });
    if (!imported) return [];
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
  const elements = usable.map((el) => {
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
  const edges = data.edges
    .filter((e) => ids.has(e.fromId) && ids.has(e.toId))
    .map((e) => ({ ...e, id: uuidv7(), fromId: ids.get(e.fromId)!, toId: ids.get(e.toId)! }));
  canvas().insertCards(elements, edges);
  return usable.filter(isTop).map((el) => ids.get(el.id)!);
}

/**
 * 粘贴到画布：依次尝试栖页卡片 → 剪贴板中的文件（如资源管理器里复制的）→
 * 浏览器给出的文件（如截图）→ 纯文本（只有网址时变成链接卡片）。fallback 需在 paste 事件中同步读取。
 * parentId 不为空时粘贴到那个文件夹里（at 只用于保存位置）。返回粘贴出来的最外层元素
 */
export async function pasteIntoCanvas(at: Point, fallback: { files: File[]; text: string }, parentId?: ID): Promise<ID[]> {
  const add = (elements: CanvasElement[]) => {
    canvas().addElements(elements, { select: !parentId });
    return elements.filter((el) => el.parentId === parentId).map((el) => el.id);
  };
  const into = (elements: CanvasElement[]) => (parentId ? elements.map((el) => ({ ...el, parentId })) : elements);
  try {
    const clip = await backend.readClipboard().catch(() => null);
    const cards = parseCards(clip?.cards ?? null);
    if (cards) return await pasteCards(cards, at, parentId);

    // 资源管理器中复制的文件和文件夹：文件夹变成文件夹卡片
    if (clip?.files.length) {
      const files = clip.files;
      const nodes = await runImport((task) => backend.importTree(files, task), {
        key: pathsKey(files),
        done: (n) => importedMessage(assetsInTree(n).length),
      });
      if (!nodes) return [];
      app().addAssets(assetsInTree(nodes));
      return add(elementsForTree(nodes, at, parentId));
    }
    let imported: Asset[] = [];
    if (fallback.files.length) {
      imported = (await runImport((task) => backend.importBlobs(fallback.files, task), { done: (a) => importedMessage(a.length) })) ?? [];
    }
    if (imported.length) {
      app().addAssets(imported);
      return add(into(elementsForAssets(imported, at)));
    }

    const text = fallback.text || clip?.text || "";
    const urls = urlsInText(text);
    if (urls.length) return placeLinks(urls, at, parentId).map((el) => el.id);
    if (text.trim()) return add(into([newTextCard(at, text)]));
  } catch (e) {
    app().showToast(t("粘贴失败：{error}", { error: String(e) }));
  }
  return [];
}
