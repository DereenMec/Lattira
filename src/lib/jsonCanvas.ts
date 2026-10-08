/**
 * 画布文件格式：兼容 JSON Canvas 1.0（https://jsoncanvas.org），
 * 栖页独有的信息放在 `lattira` 扩展字段中，Obsidian 等工具打开时会忽略它们。
 */
import type { Asset, CanvasDoc, CanvasElement, CardColor, Edge, ID } from "@/types/model";

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
    type: CanvasElement["type"];
    assetId?: ID;
    createdAt: number;
    updatedAt: number;
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
      lattira: { type: el.type, createdAt: el.createdAt, updatedAt: el.updatedAt } as JsonCanvasNode["lattira"],
    };
    switch (el.type) {
      case "text":
        return { ...base, type: "text", text: el.text };
      case "section":
        return { ...base, type: "group", label: el.label };
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

export function fromJsonCanvas(json: string, canvasId: ID): CanvasDoc {
  const empty: CanvasDoc = { canvasId, elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!json.trim()) return empty;
  const file = JSON.parse(json) as Partial<JsonCanvasFile>;
  const now = Date.now();
  const elements: CanvasElement[] = [];
  for (const n of file.nodes ?? []) {
    const common = {
      id: n.id,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      color: n.color ? PRESET_TO_COLOR[n.color] : undefined,
      createdAt: n.lattira?.createdAt ?? now,
      updatedAt: n.lattira?.updatedAt ?? now,
    };
    const kind = n.lattira?.type;
    if (n.type === "group") {
      elements.push({ ...common, type: "section", label: n.label ?? "" });
    } else if (n.type === "file" && n.lattira?.assetId) {
      elements.push({ ...common, type: kind === "image" ? "image" : "file", assetId: n.lattira.assetId });
    } else if (n.type === "link") {
      elements.push({ ...common, type: "text", text: n.url ?? "" });
    } else {
      // 文本节点，以及暂不能解析的外部文件节点（显示其路径）
      elements.push({ ...common, type: "text", text: n.text ?? n.file ?? "" });
    }
  }
  const ids = new Set(elements.map((e) => e.id));
  const edges: Edge[] = (file.edges ?? [])
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map((e) => ({ id: e.id, fromId: e.fromNode, toId: e.toNode, label: e.label }));
  return { canvasId, elements, edges, viewport: file.lattira?.viewport ?? empty.viewport };
}
