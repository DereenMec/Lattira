export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const isImageMime = (mime: string) => mime.startsWith("image/");

/** 与 src-tauri/src/ocr.rs 中的 OCR_MIMES 一致：这些格式的图片会做文字识别 */
const OCR_MIMES = new Set(["image/png", "image/jpeg", "image/bmp", "image/gif", "image/tiff", "image/webp"]);
export const isOcrMime = (mime: string) => OCR_MIMES.has(mime);
