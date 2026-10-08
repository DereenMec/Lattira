import { uuidv7 } from "@/lib/id";
import { toJsonCanvas } from "@/lib/jsonCanvas";
import { buildPreview } from "@/lib/preview";
import { msg, t } from "@/i18n";
import { backend } from "@/services/backend";
import type { CanvasDoc, CanvasElement, CanvasMeta, CardColor, Edge, ID } from "@/types/model";

const CARDS: { text: string; x: number; y: number; color?: CardColor }[] = [
  {
    text: msg("欢迎来到栖页\n\n这是一张画布。资料以卡片的形式摆在这里，位置、分组和连线本身就是信息。"),
    x: 0,
    y: 0,
    color: "green",
  },
  { text: msg("新建卡片\n\n双击空白处新建文本卡片。把文件或图片拖进窗口，它们会被复制进工作区。"), x: 340, y: 0 },
  { text: msg("整理\n\n拖动卡片调整位置。Shift+点击多选，或在空白处拖出选框；Ctrl+G 把选中的卡片放进分组框。"), x: 680, y: 0 },
  { text: msg("连线\n\n选中一张卡片，拖动它右侧的小圆点到另一张卡片上。"), x: 680, y: 220 },
  { text: msg("移动画布\n\n滚轮平移，Ctrl+滚轮缩放，按住空格拖动也能平移。Shift+1 显示全部内容。"), x: 340, y: 220 },
  { text: msg("回溯与搜索\n\n左侧「日历」按天列出你编辑过的画布。Ctrl+E 搜索所有画布里的文字、文件名和图片中的文字。"), x: 0, y: 220, color: "blue" },
];

/** 新工作区的欢迎画布：用卡片本身演示操作 */
export async function seedWelcomeCanvas(canvasId: ID): Promise<CanvasMeta> {
  const now = Date.now();
  const elements: CanvasElement[] = CARDS.map((c) => ({
    id: uuidv7(),
    type: "text",
    text: t(c.text),
    x: c.x,
    y: c.y,
    width: 280,
    height: 160,
    color: c.color,
    createdAt: now,
    updatedAt: now,
  }));
  const edges: Edge[] = elements.slice(0, -1).map((el, i) => ({ id: uuidv7(), fromId: el.id, toId: elements[i + 1].id }));
  const doc: CanvasDoc = { canvasId, elements, edges, viewport: { x: 120, y: 120, zoom: 1 } };
  return backend.saveCanvas(
    canvasId,
    toJsonCanvas(doc, new Map()),
    {
      elementCount: elements.length,
      texts: elements.map((e) => ({ elementId: e.id, text: e.type === "text" ? e.text : "" })),
      assetIds: [],
      preview: buildPreview(doc, new Map()),
    },
    { added: elements.length + edges.length, modified: 0, removed: 0 },
  );
}
