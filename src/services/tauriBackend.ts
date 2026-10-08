import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Asset, CanvasDay, CanvasMeta, ImportNode, Project, SearchHit, WorkspaceInfo } from "@/types/model";
import { t } from "@/i18n";
import type { Backend, ClipboardContent } from "./backend";

const toWindowsPath = (root: string, rel: string) => `${root}\\${rel.replaceAll("/", "\\")}`;

/** 调用 src-tauri/src/commands.rs 中的命令。参数名由 Tauri 自动从 camelCase 转为 snake_case。 */
export function createTauriBackend(): Backend {
  let root = "";

  const remember = (ws: WorkspaceInfo | null) => {
    if (ws) root = ws.path;
    return ws;
  };

  return {
    kind: "tauri",

    restoreWorkspace: async () => remember(await invoke<WorkspaceInfo | null>("restore_workspace")),
    async pickWorkspace() {
      const dir = await open({ directory: true, title: t("选择或新建一个文件夹作为栖页工作区") });
      if (typeof dir !== "string") return null;
      return remember(await invoke<WorkspaceInfo>("open_workspace", { path: dir }));
    },

    listProjects: () => invoke<Project[]>("list_projects"),
    createProject: (name, color) => invoke<Project>("create_project", { name, color }),
    updateProject: (id, patch) => invoke<Project>("update_project", { id, patch }),

    listCanvases: () => invoke<CanvasMeta[]>("list_canvases"),
    createCanvas: (projectId, title) => invoke<CanvasMeta>("create_canvas", { projectId, title }),
    updateCanvas: (id, patch) => invoke<CanvasMeta>("update_canvas", { id, patch }),
    deleteCanvas: (id) => invoke<void>("delete_canvas", { id }),
    loadCanvas: (id) => invoke<string>("load_canvas", { id }),
    saveCanvas: (id, content, index, changes) => invoke<CanvasMeta>("save_canvas", { id, content, index, changes }),

    importPaths: (paths) => invoke<Asset[]>("import_paths", { paths }),
    importTree: (paths) => invoke<ImportNode[]>("import_tree", { paths }),
    async importBlobs(files) {
      const out: Asset[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        out.push(await invoke<Asset>("import_bytes", { name: f.name || t("粘贴的图片.png"), bytes: Array.from(bytes) }));
      }
      return out;
    },
    listAssets: () => invoke<Asset[]>("list_assets"),
    assetUrl: (asset) => convertFileSrc(toWindowsPath(root, asset.path)),
    assetPath: (asset) => toWindowsPath(root, asset.path),
    revealAsset: (asset) => invoke<void>("reveal_asset", { id: asset.id }),
    revealCanvas: (id) => invoke<void>("reveal_canvas", { id }),
    revealProject: (id) => invoke<void>("reveal_project", { id }),
    revealWorkspace: () => invoke<void>("reveal_workspace"),
    renameAsset: (asset, name) => invoke<Asset>("rename_asset", { id: asset.id, name }),
    async saveAssetCopy(asset) {
      const dot = asset.name.lastIndexOf(".");
      const ext = dot > 0 ? asset.name.slice(dot + 1) : "";
      const dest = await save({
        title: t("另存为"),
        defaultPath: asset.name,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
      });
      if (!dest) return false;
      await invoke<void>("copy_asset_to", { id: asset.id, dest });
      return true;
    },
    deleteAssets: (ids) => invoke<{ canvasIds: string[]; removedCards: number }>("delete_assets", { ids }),
    copyCards: (payload) => invoke<void>("copy_cards", { payload }),
    readClipboard: () => invoke<ClipboardContent>("read_clipboard"),
    openAsset: (asset) => invoke<void>("open_asset", { id: asset.id }),
    subscribeAssetUpdates(onUpdate) {
      let stop: (() => void) | undefined;
      let cancelled = false;
      void listen<string>("asset-updated", (e) => onUpdate(e.payload)).then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      });
      return () => {
        cancelled = true;
        stop?.();
      };
    },

    calendarDays: (from, to) => invoke<CanvasDay[]>("calendar_days", { from, to }),
    search: (query) => invoke<SearchHit[]>("search", { query }),
  };
}
