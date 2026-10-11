/**
 * 画布文件格式：兼容 JSON Canvas 1.0（https://jsoncanvas.org），
 * 栖页独有的信息放在 `lattira` 扩展字段中，Obsidian 等工具打开时会忽略它们。
 *
 * 文件夹存成 group 节点（lattira.type 为 folder），里面的元素仍是普通节点，用 lattira.parent 指向所在文件夹。
 * 旧版本的分组框和其他工具画的 group 打开时转换成文件夹，框里的卡片放进去。
 */
import { boundsOf, contains } from "@/lib/geometry";
import { FOLDER_H, FOLDER_W } from "@/lib/folders";
import type { Asset, CanvasDoc, CanvasElement, CardColor, Edge, ID, LinkElement, Viewport } from "@/types/model";

interface JsonCanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  lattira?: {
    /** 旧版本的分组框为 section */
    type: CanvasElement["type"] | "section";
    assetId?: ID;
    /** 所在的文件夹 */
    parent?: ID;
    createdAt: number;
    updatedAt: number;
    /** 链接卡片获取到的网页信息 */
    link?: Pick<LinkElement, "title" | "description" | "siteName" | "image" | "icon">;
  };
}

interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  toEnd?: "none" | "arrow";
  label?: string;
}

interface JsonCanvasFile {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
  lattira?: { version: 1; viewport: CanvasDoc["viewport"] };
}

const COLOR_TO_PRESET: Record<Exclude<CardColor, "default">, string> = {
  red: "1",
  orange: "2",
  yellow: "3",
  green: "4",
  blue: "5",
  purple: "6",
};

const PRESET_TO_COLOR = Object.fromEntries(
  Object.entries(COLOR_TO_PRESET).map(([k, v]) => [v, k as CardColor]),
) as Record<string, CardColor>;

export function toJsonCanvas(doc: CanvasDoc, assets: ReadonlyMap<ID, Asset>): string {
  const nodes: JsonCanvasNode[] = doc.elements.map((el) => {
    const base = {
      id: el.id,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
      color: el.color && el.color !== "default" ? COLOR_TO_PRESET[el.color] : undefined,
      lattira: {
        type: el.type,
        ...(el.parentId ? { parent: el.parentId } : {}),
        createdAt: el.createdAt,
        updatedAt: el.updatedAt,
      } as JsonCanvasNode["lattira"],
    };
    switch (el.type) {
      case "text":
        return { ...base, type: "text", text: el.text };
      case "folder":
        return { ...base, type: "group", label: el.label };
      case "link": {
        const { title, description, siteName, image, icon } = el;
        return { ...base, type: "link", url: el.url, lattira: { ...base.lattira!, link: { title, description, siteName, image, icon } } };
      }
      case "image":
      case "file":
        return {
          ...base,
          type: "file",
          file: assets.get(el.assetId)?.path ?? "",
          lattira: { ...base.lattira!, assetId: el.assetId },
        };
    }
  });
  const edges: JsonCanvasEdge[] = doc.edges.map((e) => ({
    id: e.id,
    fromNode: e.fromId,
    toNode: e.toId,
    toEnd: "arrow",
    label: e.label,
  }));
  const file: JsonCanvasFile = { nodes, edges, lattira: { version: 1, viewport: doc.viewport } };
  return JSON.stringify(file, null, 2);
}

/** 所在文件夹不存在或互相包含（文件被手动改过）的元素放回画布上 */
function dropBrokenParents(elements: CanvasElement[]) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const el of elements) {
    const seen = new Set<ID>([el.id]);
    let cur = el;
    while (cur.parentId) {
      const parent = byId.get(cur.parentId);
      if (!parent || parent.type !== "folder" || seen.has(parent.id)) {
        delete cur.parentId;
        break;
      }
      seen.add(parent.id);
      cur = parent;
    }
  }
}

const area = (r: { width: number; height: number }) => r.width * r.height;

/**
 * 旧格式的分组框 → 文件夹：完全在框里的元素放进包住它的最小的那个框，框缩成文件夹卡片，留在原来的左上角。
 * 框里的卡片按从上到下、从左到右的顺序排在文件夹里。
 */
function convertGroups(elements: CanvasElement[], groupIds: ReadonlySet<ID>) {
  const groups = elements.filter((e) => groupIds.has(e.id));
  const moved = new Set<ID>();
  for (const el of elements) {
    if (el.parentId) continue;
    let best: CanvasElement | undefined;
    for (const g of groups) if (g.id !== el.id && contains(g, el) && (!best || area(g) < area(best))) best = g;
    if (best) {
      el.parentId = best.id;
      moved.add(el.id);
    }
  }
  // 只在放进去的元素占的那些位置之间重排，不影响其他元素的叠放次序
  const slots = elements.flatMap((e, i) => (moved.has(e.id) ? [i] : []));
  const ordered = slots.map((i) => elements[i]).sort((a, b) => a.y - b.y || a.x - b.x);
  slots.forEach((slot, k) => (elements[slot] = ordered[k]));
  for (const g of groups) {
    g.width = FOLDER_W;
    g.height = FOLDER_H;
  }
}

/** 没有保存视口的画布（导入的、其他工具编辑过的）：内容左上角留一点边距显示 */
function frameContent(elements: CanvasElement[]): Viewport {
  const b = boundsOf(elements);
  return b ? { x: 80 - b.x, y: 80 - b.y, zoom: 1 } : { x: 0, y: 0, zoom: 1 };
}

export function fromJsonCanvas(json: string, canvasId: ID): CanvasDoc {
  const empty: CanvasDoc = { canvasId, elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!json.trim()) return empty;
  const file = JSON.parse(json) as Partial<JsonCanvasFile>;
  const now = Date.now();
  const elements: CanvasElement[] = [];
  const legacyGroups = new Set<ID>();
  for (const n of file.nodes ?? []) {
    const common = {
      id: n.id,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      color: n.color ? PRESET_TO_COLOR[n.color] : undefined,
      ...(n.lattira?.parent ? { parentId: n.lattira.parent } : {}),
      createdAt: n.lattira?.createdAt ?? now,
      updatedAt: n.lattira?.updatedAt ?? now,
    };
    const kind = n.lattira?.type;
    if (n.type === "group") {
      if (kind !== "folder") legacyGroups.add(n.id);
      elements.push({ ...common, type: "folder", label: n.label ?? "" });
    } else if (n.type === "file" && n.lattira?.assetId) {
      elements.push({ ...common, type: kind === "image" ? "image" : "file", assetId: n.lattira.assetId });
    } else if (n.type === "link") {
      elements.push({ ...common, type: "link", url: n.url ?? "", ...n.lattira?.link });
    } else {
      // 文本节点，以及暂不能解析的外部文件节点（显示其路径）
      elements.push({ ...common, type: "text", text: n.text ?? n.file ?? "" });
    }
  }
  const ids = new Set(elements.map((e) => e.id));
  dropBrokenParents(elements);
  if (legacyGroups.size) convertGroups(elements, legacyGroups);
  const edges: Edge[] = (file.edges ?? [])
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map((e) => ({ id: e.id, fromId: e.fromNode, toId: e.toNode, label: e.label }));
  return { canvasId, elements, edges, viewport: file.lattira?.viewport ?? frameContent(elements.filter((e) => !e.parentId)) };
}
