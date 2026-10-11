import type { Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { isImageMime } from "@/lib/format";
import { t } from "@/i18n";
import { FOLDER_H, FOLDER_W } from "@/lib/folders";
import type { Asset, CanvasElement, FolderElement, ID, ImportNode, TextElement } from "@/types/model";

const GAP = 24;
const MAX_IMAGE_WIDTH = 360;

/** 把导入的资源排成一行，从 at 开始向右摆放 */
export function elementsForAssets(assets: Asset[], at: Point): CanvasElement[] {
  const now = Date.now();
  let x = at.x;
  return assets.map((asset) => {
    let width = 260;
    let height = 76;
    const image = isImageMime(asset.mime);
    if (image) {
      width = Math.min(asset.width ?? 320, MAX_IMAGE_WIDTH);
      height = asset.width && asset.height ? Math.round((width * asset.height) / asset.width) : 240;
    }
    const el: CanvasElement = {
      id: uuidv7(),
      type: image ? "image" : "file",
      assetId: asset.id,
      x,
      y: at.y,
      width,
      height,
      createdAt: now,
      updatedAt: now,
    };
    x += width + GAP;
    return el;
  });
}

// ---------------------------------------------------------------------------
// 导入文件夹：散落的文件按网格紧凑排好，每个文件夹是一张文件夹卡片，里面的文件和子文件夹放进它
// ---------------------------------------------------------------------------

const CELL_W = 260; // 网格中每张卡片的宽度
const FILE_H = 76;
const MAX_IMAGE_H = 260;
const CELL_GAP = 16;
/** 网格的目标宽高比：屏幕是横向的，略宽的网格更容易一屏看全 */
const TARGET_RATIO = 2;

interface Block {
  width: number;
  height: number;
  place(x: number, y: number, now: number, out: CanvasElement[]): void;
}

/** 卡片尺寸：文件统一大小；图片按比例缩到格子宽度，过高时再按高度缩 */
function cardSize(asset: Asset): { w: number; h: number } {
  if (!isImageMime(asset.mime) || !asset.width || !asset.height) return { w: CELL_W, h: FILE_H };
  let w = CELL_W;
  let h = Math.round((CELL_W * asset.height) / asset.width);
  if (h > MAX_IMAGE_H) {
    w = Math.round((MAX_IMAGE_H * asset.width) / asset.height);
    h = MAX_IMAGE_H;
  }
  return { w, h };
}

/**
 * 网格列数：让整体宽高比接近 TARGET_RATIO。
 * 宽 ≈ 列数 × 格宽，高 ≈ (n / 列数) × 平均行高，解得 列数 = √(比例 × n × 行高 / 格宽)。
 * 例如 10 个文件 → 3 列 4 行，40 个文件 → 5 列 8 行。
 */
function gridColumns(sizes: { w: number; h: number }[]): number {
  const n = sizes.length;
  const rowH = sizes.reduce((s, c) => s + c.h, 0) / n + CELL_GAP;
  const cols = Math.round(Math.sqrt((TARGET_RATIO * n * rowH) / (CELL_W + CELL_GAP)));
  return Math.min(n, Math.max(1, cols));
}

const assetCard = (asset: Asset, x: number, y: number, w: number, h: number, now: number, parentId?: ID): CanvasElement => ({
  id: uuidv7(),
  type: isImageMime(asset.mime) ? "image" : "file",
  assetId: asset.id,
  x,
  y,
  width: w,
  height: h,
  ...(parentId ? { parentId } : {}),
  createdAt: now,
  updatedAt: now,
});

/** 文件网格，以及跟在后面排成一行的文件夹卡片 */
function gridBlock(nodes: ImportNode[], parentId: ID | undefined): Block {
  const sizes = nodes.map((n) => (n.kind === "file" ? cardSize(n.asset) : { w: FOLDER_W, h: FOLDER_H }));
  const cols = gridColumns(sizes);
  const rowHeights: number[] = [];
  sizes.forEach((s, i) => {
    const r = Math.floor(i / cols);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, s.h);
  });
  const width = Math.min(cols, nodes.length) * (CELL_W + CELL_GAP) - CELL_GAP;
  const height = rowHeights.reduce((a, b) => a + b, 0) + CELL_GAP * (rowHeights.length - 1);
  return {
    width,
    height,
    place(x, y, now, out) {
      let rowY = y;
      rowHeights.forEach((rh, r) => {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (i >= nodes.length) break;
          const { w, h } = sizes[i];
          const node = nodes[i];
          const cx = x + c * (CELL_W + CELL_GAP);
          if (node.kind === "file") out.push(assetCard(node.asset, cx, rowY, w, h, now, parentId));
          else placeFolder(node, cx, rowY, now, out, parentId);
        }
        rowY += rh + CELL_GAP;
      });
    },
  };
}

/** 文件夹卡片和它里面的全部内容。里面的元素在画布上不显示，位置按网格记下，拿回画布时会重新摆放 */
function placeFolder(
  node: Extract<ImportNode, { kind: "folder" }>,
  x: number,
  y: number,
  now: number,
  out: CanvasElement[],
  parentId: ID | undefined,
) {
  const folder: FolderElement = {
    id: uuidv7(),
    type: "folder",
    label: node.name,
    x,
    y,
    width: FOLDER_W,
    height: FOLDER_H,
    ...(parentId ? { parentId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  out.push(folder);
  // 子文件夹排在前面，与文件夹窗口里的顺序一致
  const ordered = [...node.children.filter((c) => c.kind === "folder"), ...node.children.filter((c) => c.kind === "file")];
  if (ordered.length) gridBlock(ordered, folder.id).place(0, 0, now, out);
}

/**
 * 把导入结果摆到画布上：散落的文件和文件夹卡片一起排成网格，左上角在 at。
 * parentId 不为空时全部放进那个文件夹。
 */
export function elementsForTree(nodes: ImportNode[], at: Point, parentId?: ID): CanvasElement[] {
  const out: CanvasElement[] = [];
  if (nodes.length === 0) return out;
  const ordered = [...nodes.filter((n) => n.kind === "file"), ...nodes.filter((n) => n.kind === "folder")];
  gridBlock(ordered, parentId).place(at.x, at.y, Date.now(), out);
  return out;
}

/** 导入结果中的全部资源 */
export function assetsInTree(nodes: ImportNode[]): Asset[] {
  return nodes.flatMap((n) => (n.kind === "file" ? [n.asset] : assetsInTree(n.children)));
}

/** 空文件夹卡片，以 at 为中心；parentId 不为空时建在那个文件夹里 */
export function newFolder(at: Point, parentId?: ID): FolderElement {
  const now = Date.now();
  return {
    id: uuidv7(),
    type: "folder",
    label: t("新文件夹"),
    x: at.x - FOLDER_W / 2,
    y: at.y - FOLDER_H / 2,
    width: FOLDER_W,
    height: FOLDER_H,
    ...(parentId ? { parentId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function newTextCard(at: Point, text = ""): TextElement {
  const now = Date.now();
  return { id: uuidv7(), type: "text", text, x: at.x - 140, y: at.y - 40, width: 280, height: 140, createdAt: now, updatedAt: now };
}
