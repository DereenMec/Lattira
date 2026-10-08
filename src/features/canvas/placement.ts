import type { Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { isImageMime } from "@/lib/format";
import type { Asset, CanvasElement, TextElement } from "@/types/model";

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

export function newTextCard(at: Point, text = ""): TextElement {
  const now = Date.now();
  return { id: uuidv7(), type: "text", text, x: at.x - 140, y: at.y - 40, width: 280, height: 140, createdAt: now, updatedAt: now };
}
