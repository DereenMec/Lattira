/**
 * 画布上的文件夹：文件夹是一张卡片，里面的元素用 parentId 指向它，和画布上的元素存在同一个列表里。
 * 这里是按 parentId 组织这些元素的工具函数。
 */
import type { CanvasElement, FolderElement, ID } from "@/types/model";
import type { Point, Rect } from "./geometry";

/** 文件夹卡片的大小，与文件卡片一致 */
export const FOLDER_W = 260;
export const FOLDER_H = 76;

/** 直接放在画布上的元素 */
export const onCanvas = (el: CanvasElement) => !el.parentId;

export const isFolder = (el: CanvasElement): el is FolderElement => el.type === "folder";

/** 文件夹里的内容：子文件夹在前，其余按放进去的先后 */
export function childrenOf(elements: CanvasElement[], folderId: ID): CanvasElement[] {
  const items = elements.filter((e) => e.parentId === folderId);
  return [...items.filter(isFolder), ...items.filter((e) => !isFolder(e))];
}

/** 每个文件夹直接包含的元素数 */
export function childCounts(elements: CanvasElement[]): Map<ID, number> {
  const out = new Map<ID, number>();
  for (const e of elements) if (e.parentId) out.set(e.parentId, (out.get(e.parentId) ?? 0) + 1);
  return out;
}

/** ids 以及它们（逐层）包含的全部元素 */
export function withDescendants(elements: CanvasElement[], ids: Iterable<ID>): Set<ID> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of elements) {
      if (e.parentId && out.has(e.parentId) && !out.has(e.id)) {
        out.add(e.id);
        grew = true;
      }
    }
  }
  return out;
}

/** ids 以及逐层包含它们的文件夹 */
export function withAncestors(elements: CanvasElement[], ids: Iterable<ID>): Set<ID> {
  const out = new Set<ID>();
  const parentOf = new Map(elements.map((e) => [e.id, e.parentId]));
  for (const id of ids) {
    let cur: ID | undefined = id;
    // 遇到已经加过的就停：它的上层也都加过了
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return out;
}

/** 从画布上那一层到 id 本身的文件夹链（不含 id 为非文件夹时的它自己） */
export function folderChain(byId: ReadonlyMap<ID, CanvasElement>, id: ID): FolderElement[] {
  const chain: FolderElement[] = [];
  let cur = byId.get(id);
  // 防止损坏的文件里出现循环引用
  const seen = new Set<ID>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (isFolder(cur)) chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/** 元素所在的、直接放在画布上的那一层祖先（它本身在画布上时就是它自己） */
export function canvasAncestor(byId: ReadonlyMap<ID, CanvasElement>, id: ID): CanvasElement | undefined {
  let cur = byId.get(id);
  const seen = new Set<ID>();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return cur && !cur.parentId ? cur : undefined;
}

/** 能否把 ids 放进 folderId：不能放进自己，也不能放进自己里面的文件夹 */
export function canMoveInto(elements: CanvasElement[], ids: Iterable<ID>, folderId: ID): boolean {
  return !withDescendants(elements, ids).has(folderId);
}

export const folderName = (f: FolderElement, untitled: string) => f.label.trim() || untitled;

/**
 * 把一批元素排到画布上：第一个的中心对准 at，其余向右排，排成接近 2:1 的网格。返回每个元素的新位置。
 */
export function arrangeAt(items: Rect[], at: Point, gap = 24): Point[] {
  const n = items.length;
  if (n === 0) return [];
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt(n * 2))));
  const colW = Math.max(...items.map((r) => r.width));
  const out: Point[] = [];
  let y = at.y - items[0].height / 2;
  for (let start = 0; start < n; start += cols) {
    const row = items.slice(start, start + cols);
    const x = at.x - items[0].width / 2;
    row.forEach((_, k) => out.push({ x: x + k * (colW + gap), y }));
    y += Math.max(...row.map((r) => r.height)) + gap;
  }
  return out;
}
