import type { Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { isImageMime } from "@/lib/format";
import { t } from "@/i18n";
import type { Asset, CanvasElement, ImportNode, SectionElement, TextElement } from "@/types/model";

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
// 导入文件夹：每个文件夹是一个分组框，文件按网格紧凑排在框里，子文件夹作为嵌套的分组框放在文件下方
// ---------------------------------------------------------------------------

const CELL_W = 260; // 网格中每张卡片的宽度
const FILE_H = 76;
const MAX_IMAGE_H = 260;
const CELL_GAP = 16;
const PAD = 24; // 分组框内边距
const LABEL_SPACE = 44; // 分组框顶部留给标题的高度
/** 网格的目标宽高比：屏幕是横向的，略宽的分组更容易一屏看全 */
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

function gridBlock(assets: Asset[]): Block {
  const sizes = assets.map(cardSize);
  const cols = gridColumns(sizes);
  const rowHeights: number[] = [];
  sizes.forEach((s, i) => {
    const r = Math.floor(i / cols);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, s.h);
  });
  const width = Math.min(cols, assets.length) * (CELL_W + CELL_GAP) - CELL_GAP;
  const height = rowHeights.reduce((a, b) => a + b, 0) + CELL_GAP * (rowHeights.length - 1);
  return {
    width,
    height,
    place(x, y, now, out) {
      let rowY = y;
      rowHeights.forEach((rh, r) => {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (i >= assets.length) break;
          const { w, h } = sizes[i];
          out.push({
            id: uuidv7(),
            type: isImageMime(assets[i].mime) ? "image" : "file",
            assetId: assets[i].id,
            x: x + c * (CELL_W + CELL_GAP),
            y: rowY,
            width: w,
            height: h,
            createdAt: now,
            updatedAt: now,
          });
        }
        rowY += rh + CELL_GAP;
      });
    },
  };
}

/** 把若干块从左到右排列，超过 maxWidth 换行 */
function flowBlocks(blocks: Block[], maxWidth: number, gap: number): Block {
  const rows: { items: Block[]; height: number; width: number }[] = [];
  for (const b of blocks) {
    const row = rows.at(-1);
    if (row && row.width + gap + b.width <= maxWidth) {
      row.items.push(b);
      row.width += gap + b.width;
      row.height = Math.max(row.height, b.height);
    } else {
      rows.push({ items: [b], width: b.width, height: b.height });
    }
  }
  return {
    width: Math.max(0, ...rows.map((r) => r.width)),
    height: rows.reduce((s, r) => s + r.height, 0) + gap * Math.max(0, rows.length - 1),
    place(x, y, now, out) {
      let rowY = y;
      for (const row of rows) {
        let colX = x;
        for (const b of row.items) {
          b.place(colX, rowY, now, out);
          colX += b.width + gap;
        }
        rowY += row.height + gap;
      }
    },
  };
}

/** 文件网格在上、子文件夹在下的内容区 */
function contentBlock(children: ImportNode[]): Block | null {
  const files = children.flatMap((c) => (c.kind === "file" ? [c.asset] : []));
  const folders = children.flatMap((c) => (c.kind === "folder" ? [folderBlock(c.name, c.children)] : []));
  const grid = files.length ? gridBlock(files) : null;
  const wrapWidth = Math.max(grid?.width ?? 0, ...folders.map((f) => f.width), CELL_W * 3);
  const subs = folders.length ? flowBlocks(folders, wrapWidth, CELL_GAP * 2) : null;
  const parts = [grid, subs].filter((b): b is Block => b !== null);
  if (parts.length === 0) return null;
  const gap = CELL_GAP * 2;
  return {
    width: Math.max(...parts.map((p) => p.width)),
    height: parts.reduce((s, p) => s + p.height, 0) + gap * (parts.length - 1),
    place(x, y, now, out) {
      let cy = y;
      for (const p of parts) {
        p.place(x, cy, now, out);
        cy += p.height + gap;
      }
    },
  };
}

function folderBlock(name: string, children: ImportNode[]): Block {
  const content = contentBlock(children);
  const width = Math.max(content?.width ?? 0, CELL_W) + PAD * 2;
  const height = LABEL_SPACE + (content?.height ?? FILE_H) + PAD;
  return {
    width,
    height,
    place(x, y, now, out) {
      // 分组框先放进数组，嵌套的子分组排在后面，绘制时位于上层
      out.push({ id: uuidv7(), type: "section", label: name, x, y, width, height, createdAt: now, updatedAt: now });
      content?.place(x + PAD, y + LABEL_SPACE, now, out);
    },
  };
}

/** 把导入结果摆到画布上：散落的文件排成网格，每个文件夹一个分组框，从 at 开始向右排列 */
export function elementsForTree(nodes: ImportNode[], at: Point): CanvasElement[] {
  const files = nodes.flatMap((n) => (n.kind === "file" ? [n.asset] : []));
  const blocks: Block[] = [
    ...(files.length ? [gridBlock(files)] : []),
    ...nodes.flatMap((n) => (n.kind === "folder" ? [folderBlock(n.name, n.children)] : [])),
  ];
  const out: CanvasElement[] = [];
  const now = Date.now();
  flowBlocks(blocks, Number.POSITIVE_INFINITY, GAP * 2).place(at.x, at.y, now, out);
  return out;
}

/** 导入结果中的全部资源 */
export function assetsInTree(nodes: ImportNode[]): Asset[] {
  return nodes.flatMap((n) => (n.kind === "file" ? [n.asset] : assetsInTree(n.children)));
}

/** 画布上的空文件夹（分组框），以 at 为中心；之后可以把卡片拖进去 */
export function newFolder(at: Point): SectionElement {
  const now = Date.now();
  const width = 560;
  const height = 360;
  return {
    id: uuidv7(),
    type: "section",
    label: t("新文件夹"),
    x: at.x - width / 2,
    y: at.y - height / 2,
    width,
    height,
    createdAt: now,
    updatedAt: now,
  };
}

export function newTextCard(at: Point, text = ""): TextElement {
  const now = Date.now();
  return { id: uuidv7(), type: "text", text, x: at.x - 140, y: at.y - 40, width: 280, height: 140, createdAt: now, updatedAt: now };
}
