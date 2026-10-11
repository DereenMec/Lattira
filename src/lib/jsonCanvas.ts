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
  fromEnd?: "none" | "arrow";
  color?: string;
  fromSide?: Edge["fromSide"];
  toSide?: Edge["toSide"];
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
    const original = el.source ?? {};
    const extension = { ...(original.lattira as Record<string, unknown> | undefined) };
    delete extension.parent;
    if (el.type !== "image" && el.type !== "file") delete extension.assetId;
    const base = {
      ...original,
      id: el.id,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      color: el.color ? (el.color === "default" ? undefined : COLOR_TO_PRESET[el.color]) : el.sourceColor,
      lattira: {
        ...extension,
        type: el.type,
        ...(el.parentId ? { parent: el.parentId } : {}),
        createdAt: el.createdAt,
        updatedAt: el.updatedAt,
      } as JsonCanvasNode["lattira"],
    };
    switch (el.type) {
      case "text":
        if (original.type === "file" && el.text === original.file) return { ...base, type: "file", file: el.text };
        return { ...base, type: "text", text: el.text };
      case "folder":
        return { ...base, type: "group", label: el.label };
      case "link": {
        const { title, description, siteName, image, icon } = el;
        return { ...base, type: "link", url: el.url, lattira: { ...base.lattira!, link: { ...(extension.link as object), title, description, siteName, image, icon } } };
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
    ...e.source,
    id: e.id,
    fromNode: e.fromId,
    toNode: e.toId,
    fromEnd: e.fromEnd,
    toEnd: e.toEnd ?? "arrow",
    fromSide: e.fromSide,
    toSide: e.toSide,
    color: e.color,
    label: e.label,
  }));
  const file: JsonCanvasFile = { ...doc.source, nodes, edges, lattira: { ...(doc.source?.lattira as object), version: 1, viewport: doc.viewport } };
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
    for (const g of groups) {
      if (g.id !== el.id && contains(g, el) && (!groupIds.has(el.id) || area(g) > area(el) || (area(g) === area(el) && g.id < el.id)) && (!best || area(g) < area(best))) best = g;
    }
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
  if (!file || typeof file !== "object" || !Array.isArray(file.nodes) || (file.edges !== undefined && !Array.isArray(file.edges))) throw new Error("无效的 JSON Canvas 文件");
  if (file.lattira !== undefined && (!file.lattira || typeof file.lattira !== "object" || Array.isArray(file.lattira))) throw new Error("画布扩展字段无效");
  const now = Date.now();
  const elements: CanvasElement[] = [];
  const legacyGroups = new Set<ID>();
  const nodeIds = new Set<string>();
  for (const n of file.nodes ?? []) {
    if (!n || typeof n.id !== "string" || !n.id || nodeIds.has(n.id) || !["text", "file", "link", "group"].includes(n.type)) throw new Error("画布节点类型或 ID 无效");
    nodeIds.add(n.id);
    if (![n.x, n.y, n.width, n.height].every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9) || n.width <= 0 || n.height <= 0) throw new Error("画布节点尺寸无效");
    for (const key of ["text", "file", "url", "label", "color"] as const) if (n[key] !== undefined && typeof n[key] !== "string") throw new Error("画布节点内容无效");
    if (n.lattira !== undefined) {
      if (!n.lattira || typeof n.lattira !== "object" || Array.isArray(n.lattira)) throw new Error("画布扩展字段无效");
      for (const key of ["type", "assetId", "parent"] as const) if (n.lattira[key] !== undefined && typeof n.lattira[key] !== "string") throw new Error("画布扩展字段无效");
      for (const key of ["createdAt", "updatedAt"] as const) if (n.lattira[key] !== undefined && !Number.isFinite(n.lattira[key])) throw new Error("画布时间无效");
      if (n.lattira.link !== undefined) {
        if (!n.lattira.link || typeof n.lattira.link !== "object" || Array.isArray(n.lattira.link)) throw new Error("链接信息无效");
        for (const key of ["title", "description", "siteName", "image", "icon"] as const) if (n.lattira.link[key] !== undefined && typeof n.lattira.link[key] !== "string") throw new Error("链接信息无效");
      }
    }
    const common = {
      source: n as unknown as Record<string, unknown>,
      sourceColor: n.color,
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
      const link = n.lattira?.link;
      elements.push({ ...common, type: "link", url: n.url ?? "", title: link?.title, description: link?.description, siteName: link?.siteName, image: link?.image, icon: link?.icon });
    } else {
      // 文本节点，以及暂不能解析的外部文件节点（显示其路径）
      elements.push({ ...common, type: "text", text: n.text ?? n.file ?? "" });
    }
  }
  const ids = new Set(elements.map((e) => e.id));
  dropBrokenParents(elements);
  if (legacyGroups.size) convertGroups(elements, legacyGroups);
  dropBrokenParents(elements);
  const edgeIds = new Set<string>();
  for (const e of file.edges ?? []) {
    if (!e || typeof e.id !== "string" || !e.id || edgeIds.has(e.id) || typeof e.fromNode !== "string" || typeof e.toNode !== "string") throw new Error("画布连线 ID 无效");
    edgeIds.add(e.id);
    for (const key of ["label", "color"] as const) if (e[key] !== undefined && typeof e[key] !== "string") throw new Error("画布连线内容无效");
    for (const key of ["fromEnd", "toEnd"] as const) if (e[key] !== undefined && !["none", "arrow"].includes(e[key])) throw new Error("画布连线箭头无效");
    for (const key of ["fromSide", "toSide"] as const) if (e[key] !== undefined && !["top", "right", "bottom", "left"].includes(e[key])) throw new Error("画布连线方向无效");
  }
  const edges: Edge[] = (file.edges ?? [])
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map((e) => ({ ...e, source: e as unknown as Record<string, unknown>, id: e.id, fromId: e.fromNode, toId: e.toNode, label: e.label }));
  const viewport = file.lattira?.viewport;
  if (viewport && (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0 || viewport.zoom > 100)) throw new Error("画布视口无效");
  const { nodes: _nodes, edges: _edges, ...source } = file;
  return { source: source as unknown as Record<string, unknown>, canvasId, elements, edges, viewport: viewport ?? frameContent(elements.filter((e) => !e.parentId)) };
}
