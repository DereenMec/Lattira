/** 按扩展名选择文件类型图标，图标见 src/assets/file-icons（来源与许可见该目录 LICENSE.md） */
import { fileExtension } from "./format";

const ICONS = import.meta.glob<string>("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const iconUrl = (name: string) => ICONS[`../assets/file-icons/${name}.svg`];

/** 图标名 → 扩展名 */
const GROUPS: Record<string, string[]> = {
  word: ["doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "wps"],
  excel: ["xls", "xlsx", "xlsm", "xlsb", "ods", "et"],
  csv: ["csv", "tsv"],
  powerpoint: ["ppt", "pptx", "pptm", "pps", "ppsx", "odp", "dps"],
  pdf: ["pdf"],
  text: ["txt"],
  markdown: ["md", "markdown"],
  zip: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
  audio: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma", "opus"],
  video: ["mp4", "mov", "mkv", "avi", "wmv", "flv", "webm", "m4v"],
  image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "ico", "heic", "avif"],
  svg: ["svg"],
  photoshop: ["psd", "psb"],
  ai: ["ai", "eps"],
  sketch: ["sketch"],
  blender: ["blend"],
  html: ["html", "htm", "mhtml"],
  css: ["css", "scss", "sass", "less"],
  js: ["js", "mjs", "cjs", "jsx"],
  typescript: ["ts", "tsx", "mts", "cts"],
  python: ["py", "pyw", "ipynb"],
  java: ["java", "jar", "class"],
  cpp: ["c", "cc", "cpp", "cxx", "h", "hpp"],
  csharp: ["cs"],
  go: ["go"],
  rust: ["rs"],
  json: ["json", "jsonc"],
  xml: ["xml"],
  yaml: ["yml", "yaml"],
  sql: ["sql"],
  db: ["db", "sqlite", "sqlite3"],
  access: ["mdb", "accdb"],
  onenote: ["one"],
  outlook: ["msg", "eml", "pst"],
  epub: ["epub", "mobi", "azw3"],
  log: ["log"],
  ini: ["ini", "cfg", "conf"],
  config: ["toml", "env", "properties"],
  powershell: ["ps1", "psm1"],
  shell: ["sh", "bash", "zsh"],
  bat: ["bat", "cmd"],
  binary: ["exe", "dll", "msi", "bin", "iso", "dmg"],
  font: ["ttf", "otf", "woff", "woff2"],
  vsix: ["vsix"],
  drawio: ["drawio", "dio"],
};

const BY_EXT = new Map<string, string>();
for (const [icon, exts] of Object.entries(GROUPS)) for (const ext of exts) BY_EXT.set(ext, icon);

/** draw.io 导出的可编辑图片：a.drawio.png、a.drawio.svg */
const DRAWIO_EXPORT = /\.(drawio|dio)\.(png|svg|xml)$/i;

export function fileIconUrl(fileName: string): string {
  const icon = DRAWIO_EXPORT.test(fileName) ? "drawio" : (BY_EXT.get(fileExtension(fileName)) ?? "default");
  return iconUrl(icon) ?? iconUrl("default");
}
