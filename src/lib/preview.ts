/**
 * 画布缩略图数据：保存时从画布内容提取一份精简布局（位置、颜色、首行文字、图片引用），
 * 存在元数据库里，项目页与「最近」页直接用它画 SVG 缩略图，不必读取画布文件。
 */
import type { Asset, CanvasDoc, CardColor, ID } from "@/types/model";
import { paintOrder } from "./geometry";

const MAX_ITEMS = 150;
const MAX_EDGES = 120;
const MAX_LABEL = 24;

export interface PreviewItem {
  /** x 文本 · i 图片 · f 文件 · s 分组框 */
  t: "x" | "i" | "f" | "s";
  x: number;
  y: number;
  w: number;
  h: number;
  c?: CardColor;
  /** 首行文字 / 文件名 / 分组标题 */
  l?: string;
  /** 图片的资源 id */
  a?: ID;
}

export interface CanvasPreview {
  v: 1;
  items: PreviewItem[];
  /** 连线，值为 items 中的下标 */
  edges: [number, number][];
}

const TYPE_CODE = { text: "x", image: "i", file: "f", section: "s" } as const;

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, MAX_LABEL);

export function buildPreview(doc: CanvasDoc, assets: ReadonlyMap<ID, Asset>): string {
  const ordered = paintOrder(doc.elements).slice(0, MAX_ITEMS);
  const index = new Map(ordered.map((el, i) => [el.id, i]));
  const items: PreviewItem[] = ordered.map((el) => {
    const item: PreviewItem = {
      t: TYPE_CODE[el.type],
      x: Math.round(el.x),
      y: Math.round(el.y),
      w: Math.round(el.width),
      h: Math.round(el.height),
    };
    if (el.color && el.color !== "default") item.c = el.color;
    if (el.type === "text") item.l = firstLine(el.text);
    else if (el.type === "section") item.l = firstLine(el.label);
    else if (el.type === "file") item.l = (assets.get(el.assetId)?.name ?? "").slice(0, MAX_LABEL);
    else item.a = el.assetId;
    return item;
  });
  const edges: [number, number][] = [];
  for (const e of doc.edges) {
    const a = index.get(e.fromId);
    const b = index.get(e.toId);
    if (a !== undefined && b !== undefined) edges.push([a, b]);
    if (edges.length >= MAX_EDGES) break;
  }
  const preview: CanvasPreview = { v: 1, items, edges };
  return JSON.stringify(preview);
}

export function parsePreview(raw: string | null | undefined): CanvasPreview | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as CanvasPreview;
    return p.v === 1 && Array.isArray(p.items) ? p : null;
  } catch {
    return null;
  }
}
