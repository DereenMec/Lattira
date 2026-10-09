import type { CanvasElement, ID, SectionElement, Viewport } from "@/types/model";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const screenToWorld = (p: Point, vp: Viewport): Point => ({
  x: (p.x - vp.x) / vp.zoom,
  y: (p.y - vp.y) / vp.zoom,
});

/** 以屏幕上的某点为中心缩放 */
export function zoomAt(vp: Viewport, screen: Point, nextZoom: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(screen, vp);
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom };
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 让给定区域完整显示在视口内 */
export function fitRect(rect: Rect, screenW: number, screenH: number, padding = 80, maxZoom = 1): Viewport {
  const zoom = clampZoom(
    Math.min(
      (screenW - padding * 2) / Math.max(rect.width, 1),
      (screenH - padding * 2) / Math.max(rect.height, 1),
      maxZoom,
    ),
  );
  return {
    zoom,
    x: screenW / 2 - (rect.x + rect.width / 2) * zoom,
    y: screenH / 2 - (rect.y + rect.height / 2) * zoom,
  };
}

export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** 从矩形中心指向目标点的射线与矩形边框的交点，用于计算连线端点 */
export function rectEdgePoint(r: Rect, toward: Point): Point {
  const c = center(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const s = Math.min(r.width / 2 / Math.abs(dx || 1e-9), r.height / 2 / Math.abs(dy || 1e-9));
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** 选中的元素，加上选中的分组框里的元素：移动、复制分组框时它们一起走 */
export function withContents(elements: CanvasElement[], ids: Iterable<ID>): Set<ID> {
  const out = new Set(ids);
  for (const sec of elements) {
    if (sec.type !== "section" || !out.has(sec.id)) continue;
    for (const el of elements) if (el.id !== sec.id && contains(sec, el)) out.add(el.id);
  }
  return out;
}

/** 文件夹内边距；顶部多留一些，给压在边框上的标题 */
export const SECTION_PAD = 24;
export const SECTION_TOP = 44;

const area = (r: Rect) => r.width * r.height;
const isSection = (el: CanvasElement): el is SectionElement => el.type === "section";

/** 点 p 所在的最里层文件夹（嵌套时取最小的那个），exclude 中的除外 */
export function sectionAt(elements: CanvasElement[], p: Point, exclude: ReadonlySet<ID>): SectionElement | undefined {
  let best: SectionElement | undefined;
  for (const el of elements) {
    if (!isSection(el) || exclude.has(el.id)) continue;
    const inside = p.x >= el.x && p.x <= el.x + el.width && p.y >= el.y && p.y <= el.y + el.height;
    if (inside && (!best || area(el) < area(best))) best = el;
  }
  return best;
}

/** 完整包住 rect 的最里层文件夹 */
export function sectionAround(elements: CanvasElement[], rect: Rect, exclude: ReadonlySet<ID>): SectionElement | undefined {
  let best: SectionElement | undefined;
  for (const el of elements) {
    if (isSection(el) && !exclude.has(el.id) && contains(el, rect) && (!best || area(el) < area(best))) best = el;
  }
  return best;
}

/** 把文件夹扩大到能装下 rect，超出的那一边留出内边距；本来就装得下时原样返回 */
export function growToFit(section: Rect, rect: Rect): Rect {
  if (contains(section, rect)) return section;
  const x = Math.min(section.x, rect.x - SECTION_PAD);
  const y = Math.min(section.y, rect.y - SECTION_TOP);
  const right = Math.max(section.x + section.width, rect.x + rect.width + SECTION_PAD);
  const bottom = Math.max(section.y + section.height, rect.y + rect.height + SECTION_PAD);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 让文件夹 sectionId 装下 rect：它需要变大时，原本包着它的外层文件夹也跟着变大。
 * 返回需要修改的文件夹及其新位置大小；exclude 中的元素（正在移动的）不参与。
 */
export function growSections(elements: CanvasElement[], sectionId: ID, rect: Rect, exclude: ReadonlySet<ID>): Record<ID, Rect> {
  const out: Record<ID, Rect> = {};
  const target = elements.find((e) => e.id === sectionId);
  if (!target) return out;
  const queue: [Rect, Rect][] = [];
  const grown = growToFit(target, rect);
  if (grown !== target) {
    out[sectionId] = grown;
    queue.push([target, grown]);
  }
  while (queue.length) {
    const [before, after] = queue.shift()!;
    for (const el of elements) {
      if (!isSection(el) || el.id === sectionId || exclude.has(el.id) || el.id in out) continue;
      if (!contains(el, before) || contains(el, after)) continue;
      const next = growToFit(el, after);
      out[el.id] = next;
      queue.push([el, next]);
    }
  }
  return out;
}

/** 分组框画在最底层，其余元素保持数组顺序 */
export function paintOrder(elements: CanvasElement[]): CanvasElement[] {
  return [...elements.filter((e) => e.type === "section"), ...elements.filter((e) => e.type !== "section")];
}
