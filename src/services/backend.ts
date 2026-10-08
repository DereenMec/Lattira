import type {
  Asset,
  CanvasDay,
  CanvasIndex,
  CanvasMeta,
  ChangeSummary,
  ID,
  LocalDate,
  Project,
  SearchHit,
  WorkspaceInfo,
} from "@/types/model";
import { createBrowserBackend } from "./browserBackend";
import { createTauriBackend } from "./tauriBackend";

export type ProjectPatch = Partial<Pick<Project, "name" | "color" | "pinned" | "archived">>;
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

  /** 按绝对路径导入文件（桌面端拖放），文件会被复制进工作区 */
  importPaths(paths: string[]): Promise<Asset[]>;
  /** 导入浏览器 File 对象（粘贴、浏览器拖放） */
  importBlobs(files: File[]): Promise<Asset[]>;
  listAssets(): Promise<Asset[]>;
  assetUrl(asset: Asset): string;
  /** 用系统默认程序打开文件 */
  openAsset(asset: Asset): Promise<void>;
  /** 后台 OCR 等更新了某个资源时回调；返回取消订阅函数 */
  subscribeAssetUpdates(onUpdate: (assetId: ID) => void): () => void;

  /** 日历：返回 [from, to] 区间内每个画布被编辑过的日期 */
  calendarDays(from: LocalDate, to: LocalDate): Promise<CanvasDay[]>;
  search(query: string): Promise<SearchHit[]>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const backend: Backend = isTauri ? createTauriBackend() : createBrowserBackend();
