import { folderChain, folderName } from "@/lib/folders";
import { fromJsonCanvas } from "@/lib/jsonCanvas";
import type { CanvasElement, ID } from "@/types/model";

/** 每张引用卡片都有自己的位置，同一资源可以出现在同一画布的不同文件夹。 */
export interface AssetLocation {
  canvasId: ID;
  elementId?: ID;
  label: string;
}

export interface AssetOccurrence {
  elementId: ID;
  folders: string[];
}

export type LocationIndex = ReadonlyMap<ID, AssetOccurrence[]>;

/** 与打开画布共用解析及父级链规则，兼容旧分组，且不限制文件夹深度。 */
export function indexAssetLocations(elements: CanvasElement[], untitled: string): LocationIndex {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const index = new Map<ID, AssetOccurrence[]>();
  for (const el of elements) {
    if (el.type !== "file" && el.type !== "image") continue;
    const occurrence = { elementId: el.id, folders: folderChain(byId, el.id).map((f) => folderName(f, untitled)) };
    const entries = index.get(el.assetId);
    if (entries) entries.push(occurrence);
    else index.set(el.assetId, [occurrence]);
  }
  return index;
}

/** 每个画布只读一次；限制并发，离开资源库或切换工作区后停止调度与交付。 */
export async function loadLocationIndexes(
  canvasIds: ID[],
  load: (id: ID) => Promise<string>,
  untitled: string,
  active: () => boolean,
  deliver: (id: ID, index: LocationIndex) => void,
  failed: (id: ID, error: unknown) => void,
): Promise<void> {
  const queue = [...new Set(canvasIds)];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (active() && next < queue.length) {
      const id = queue[next++];
      try {
        const raw = await load(id);
        if (!active()) return;
        deliver(id, indexAssetLocations(fromJsonCanvas(raw, id).elements, untitled));
      } catch (error) {
        if (active()) failed(id, error);
      }
    }
  }));
}
