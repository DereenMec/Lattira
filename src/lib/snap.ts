/**
 * 拖动与调整大小时的吸附：卡片的左、中、右（上、中、下）靠近其他卡片的对应位置时对齐过去，
 * 并给出参考线。参与对齐的只有手势开始时视口里的卡片，看不见的卡片不会把选中的卡片“吸”走。
 */
import type { Rect } from "./geometry";

/** 吸附距离（屏幕像素），换算到画布坐标时除以缩放 */
export const SNAP_PX = 6;

/** 参考线：axis 为 x 时是一条竖线（x = at，从 from 到 to），为 y 时是横线 */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

interface Stop {
  v: number;
  r: Rect;
}

export interface SnapTargets {
  xs: Stop[];
  ys: Stop[];
}

export function snapTargets(rects: Rect[]): SnapTargets {
  const xs: Stop[] = [];
  const ys: Stop[] = [];
  for (const r of rects) {
    xs.push({ v: r.x, r }, { v: r.x + r.width / 2, r }, { v: r.x + r.width, r });
    ys.push({ v: r.y, r }, { v: r.y + r.height / 2, r }, { v: r.y + r.height, r });
  }
  return { xs, ys };
}

/** values 中任意一个与 stops 的最近距离（带符号）；超过 threshold 时返回 0 */
function nearest(values: number[], stops: Stop[], threshold: number): number {
  let best = Infinity;
  for (const v of values) {
    for (const s of stops) {
      const d = s.v - v;
      if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best)) best = d;
    }
  }
  return best === Infinity ? 0 : best;
}

/** 与 values 对齐的那些位置上的参考线，长度覆盖移动的矩形和对齐到的卡片 */
function guidesAt(axis: "x" | "y", values: number[], rect: Rect, stops: Stop[]): Guide[] {
  const out: Guide[] = [];
  const lo = (r: Rect) => (axis === "x" ? r.y : r.x);
  const hi = (r: Rect) => (axis === "x" ? r.y + r.height : r.x + r.width);
  for (const v of new Set(values)) {
    const hits = stops.filter((s) => Math.abs(s.v - v) < 0.5);
    if (hits.length === 0) continue;
    let from = lo(rect);
    let to = hi(rect);
    for (const h of hits) {
      from = Math.min(from, lo(h.r));
      to = Math.max(to, hi(h.r));
    }
    out.push({ axis, at: v, from, to });
  }
  return out;
}

const xStops = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width];
const yStops = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height];

/** 移动：返回吸附后的额外偏移和参考线 */
export function snapMove(rect: Rect, targets: SnapTargets, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const dx = nearest(xStops(rect), targets.xs, threshold);
  const dy = nearest(yStops(rect), targets.ys, threshold);
  const moved = { ...rect, x: rect.x + dx, y: rect.y + dy };
  const guides = [...guidesAt("x", xStops(moved), moved, targets.xs), ...guidesAt("y", yStops(moved), moved, targets.ys)];
  return { dx, dy, guides };
}

/**
 * 调整大小（拖右下角）：右边和下边对齐到其他卡片；keepRatio 时只对齐右边，高度随宽度变化。
 * 返回吸附后的宽高和参考线。
 */
export function snapResize(
  rect: Rect,
  targets: SnapTargets,
  threshold: number,
  keepRatio: boolean,
): { width: number; height: number; guides: Guide[] } {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const width = rect.width + nearest([right], targets.xs, threshold);
  const height = keepRatio ? (rect.height * width) / rect.width : rect.height + nearest([bottom], targets.ys, threshold);
  const r = { ...rect, width, height };
  const guides = [
    ...guidesAt("x", [r.x + r.width], r, targets.xs),
    ...(keepRatio ? [] : guidesAt("y", [r.y + r.height], r, targets.ys)),
  ];
  return { width, height, guides };
}
