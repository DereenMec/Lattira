import type {
  Asset,
  CanvasDay,
  CanvasIndex,
  CanvasMeta,
  ChangeSummary,
  ID,
  ImportNode,
  LinkPreview,
  LocalDate,
  Project,
  SearchHit,
  TrashItem,
  TrashRef,
  WorkspaceInfo,
} from "@/types/model";
import { createBrowserBackend } from "./browserBackend";
import { createTauriBackend } from "./tauriBackend";

/** Ctrl+C 复制卡片时写入系统剪贴板的内容，见 src-tauri/src/clipboard.rs */
export interface CopyPayload {
  /** 文件 / 图片卡片引用的资源，以文件形式复制 */
  assetIds: ID[];
  /** 文本卡片；与文件一起复制时会写成 .txt 文件 */
  texts: { name: string; text: string }[];
  plainText: string;
  /** 栖页卡片数据（JSON），粘贴回画布时还原布局 */
  cards: string;
}

export interface ClipboardContent {
  cards: string | null;
  files: string[];
  text: string | null;
}

export type ProjectPatch = Partial<Pick<Project, "name" | "color" | "icon" | "pinned" | "archived">>;
export type CanvasPatch = Partial<Pick<CanvasMeta, "title" | "projectId">>;

/**
 * 前端与存储层之间的唯一接口。
 * 桌面端由 Rust（src-tauri）实现；在普通浏览器里运行 `npm run dev` 时使用 localStorage 版本，便于调界面。
 */
export interface Backend {
  readonly kind: "tauri" | "browser";

  /** 重新打开上次使用的工作区；没有则返回 null */
  restoreWorkspace(): Promise<WorkspaceInfo | null>;
  /** 让用户选择一个文件夹作为工作区；取消时返回 null */
  pickWorkspace(): Promise<WorkspaceInfo | null>;

  listProjects(): Promise<Project[]>;
  createProject(name: string, color: string): Promise<Project>;
  updateProject(id: ID, patch: ProjectPatch): Promise<Project>;

  listCanvases(): Promise<CanvasMeta[]>;
  createCanvas(projectId: ID, title: string): Promise<CanvasMeta>;
  updateCanvas(id: ID, patch: CanvasPatch): Promise<CanvasMeta>;
  deleteCanvas(id: ID): Promise<void>;
  /** 返回画布文件的原始内容（JSON Canvas） */
  loadCanvas(id: ID): Promise<string>;
  saveCanvas(id: ID, content: string, index: CanvasIndex, changes: ChangeSummary): Promise<CanvasMeta>;

  /**
   * 导入文件。task 为 importProgress 里的任务 id，给出时上报进度。
   * 按绝对路径导入文件（桌面端拖放），文件会被复制进工作区
   */
  importPaths(paths: string[], task?: string): Promise<Asset[]>;
  /** 按绝对路径导入文件和文件夹，保留文件夹结构（文件夹会在画布上变成分组框） */
  importTree(paths: string[], task?: string): Promise<ImportNode[]>;
  /** 导入浏览器 File 对象（粘贴、浏览器拖放） */
  importBlobs(files: File[], task?: string): Promise<Asset[]>;
  listAssets(): Promise<Asset[]>;
  assetUrl(asset: Asset): string;
  /** 用系统默认程序打开文件 */
  openAsset(asset: Asset): Promise<void>;
  /** 资源在磁盘上的绝对路径；浏览器预览模式下为空串 */
  assetPath(asset: Asset): string;
  /** 在资源管理器中显示并选中 */
  revealAsset(asset: Asset): Promise<void>;
  revealCanvas(canvasId: ID): Promise<void>;
  /** 打开项目对应的文件夹 */
  revealProject(projectId: ID): Promise<void>;
  /** 打开工作区根文件夹 */
  revealWorkspace(): Promise<void>;
  /** 重命名资源（磁盘上的文件一起改名）；不写扩展名时沿用原扩展名 */
  renameAsset(asset: Asset, name: string): Promise<Asset>;
  /** 删除资源：文件移到工作区回收站，并从所有画布上移除引用它们的卡片 */
  deleteAssets(ids: ID[]): Promise<{ canvasIds: ID[]; removedCards: number }>;
  /** 让用户选位置，另存一份；取消时返回 false */
  saveAssetCopy(asset: Asset): Promise<boolean>;
  /** 复制卡片到系统剪贴板 */
  copyCards(payload: CopyPayload): Promise<void>;
  readClipboard(): Promise<ClipboardContent>;
  /** 后台 OCR 等更新了某个资源时回调；返回取消订阅函数 */
  subscribeAssetUpdates(onUpdate: (assetId: ID) => void): () => void;

  /** 访问网页，获取链接卡片的标题、简介、预览图和图标（图片保存在工作区） */
  fetchLinkPreview(url: string): Promise<LinkPreview>;
  /** 用默认浏览器打开链接 */
  openUrl(url: string): Promise<void>;
  /** 工作区内文件（如链接预览图）的显示地址；path 相对工作区根目录 */
  workspaceFileUrl(path: string): string;

  /** 让用户选位置，把画布连同引用的文件导出为画布包（.zip）；取消时返回 false */
  exportCanvas(canvas: CanvasMeta): Promise<boolean>;
  /** 让用户选择画布包或 .canvas 文件导入到项目；取消时返回空数组 */
  importCanvases(projectId: ID): Promise<CanvasMeta[]>;

  /** 回收站：删除的画布和文件，按删除时间从近到远 */
  listTrash(): Promise<TrashItem[]>;
  /** 恢复；恢复的画布需要重新保存一次以重建搜索索引（见 canvasStore 的 reindexCanvas） */
  restoreTrash(items: TrashRef[]): Promise<{ canvases: CanvasMeta[]; assets: Asset[] }>;
  /** 永久删除 */
  purgeTrash(items: TrashRef[]): Promise<void>;
  emptyTrash(): Promise<void>;

  /** 日历：返回 [from, to] 区间内每个画布被编辑过的日期 */
  calendarDays(from: LocalDate, to: LocalDate): Promise<CanvasDay[]>;
  search(query: string): Promise<SearchHit[]>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const backend: Backend = isTauri ? createTauriBackend() : createBrowserBackend();
