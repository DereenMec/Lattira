import type { CanvasElement, Viewport } from "@/types/model";

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

/** 分组框画在最底层，其余元素保持数组顺序 */
export function paintOrder(elements: CanvasElement[]): CanvasElement[] {
  return [...elements.filter((e) => e.type === "section"), ...elements.filter((e) => e.type !== "section")];
}
