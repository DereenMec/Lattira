export type AssetColumn = "name" | "importedAt" | "type" | "size" | "location";
export type ResizableAssetColumn = Exclude<AssetColumn, "location">;
export type ColumnWidths = Record<ResizableAssetColumn, number>;
export const LOCATION_MIN_WIDTH = 200;

export const COLUMN_SIZES: Record<ResizableAssetColumn, { default: number; min: number; max: number }> = {
  name: { default: 300, min: 160, max: 2000 },
  importedAt: { default: 170, min: 150, max: 2000 },
  type: { default: 120, min: 90, max: 2000 },
  size: { default: 90, min: 80, max: 2000 },
};

const KEY = "lattira.assets.columnWidths";

export function clampColumnWidth(column: ResizableAssetColumn, width: number): number {
  const limits = COLUMN_SIZES[column];
  return Number.isFinite(width) ? Math.round(Math.min(limits.max, Math.max(limits.min, width))) : limits.default;
}

/** 偏好损坏或存储不可用时仍能打开资源库。每列独立校验，保留其他有效设置。 */
export function readColumnWidths(): ColumnWidths {
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { /* 使用默认宽度 */ }
  return Object.fromEntries((Object.keys(COLUMN_SIZES) as ResizableAssetColumn[]).map((column) => {
    const width = saved && typeof saved === "object" ? (saved as Record<string, unknown>)[column] : undefined;
    return [column, typeof width === "number" ? clampColumnWidth(column, width) : COLUMN_SIZES[column].default];
  })) as ColumnWidths;
}

export function saveColumnWidths(widths: ColumnWidths): void {
  try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* 仅影响下次打开时的宽度 */ }
}
