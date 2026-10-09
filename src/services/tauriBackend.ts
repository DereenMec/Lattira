import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Asset, CanvasDay, CanvasMeta, ImportNode, LinkPreview, Project, SearchHit, TrashItem, WorkspaceInfo } from "@/types/model";
import { t } from "@/i18n";
import type { Backend, ClipboardContent } from "./backend";
import { reportImportProgress, type ImportProgressEvent } from "./importProgress";

const toWindowsPath = (root: string, rel: string) => `${root}\\${rel.replaceAll("/", "\\")}`;

/** 调用 src-tauri/src/commands.rs 中的命令。参数名由 Tauri 自动从 camelCase 转为 snake_case。 */
export function createTauriBackend(): Backend {
  let root = "";

  void listen<ImportProgressEvent>("import-progress", (e) => reportImportProgress(e.payload));

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

    importPaths: (paths, task) => invoke<Asset[]>("import_paths", { paths, task }),
    importTree: (paths, task) => invoke<ImportNode[]>("import_tree", { paths, task }),
    async importBlobs(files, task) {
      const out: Asset[] = [];
      for (const [i, f] of files.entries()) {
        const name = f.name || t("粘贴的图片.png");
        if (task) reportImportProgress({ task, current: name, doneFiles: i, totalFiles: files.length, fraction: i / files.length });
        const bytes = new Uint8Array(await f.arrayBuffer());
        out.push(await invoke<Asset>("import_bytes", { name, bytes: Array.from(bytes) }));
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

    fetchLinkPreview: (url) => invoke<LinkPreview>("fetch_link_preview", { url }),
    openUrl: (url) => invoke<void>("open_url", { url }),
    workspaceFileUrl: (path) => convertFileSrc(toWindowsPath(root, path)),

    async exportCanvas(canvas) {
      const dest = await save({
        title: t("导出画布"),
        defaultPath: `${canvas.title.replace(/[<>:"/\\|?*]/g, "_")}.zip`,
        filters: [{ name: t("画布包"), extensions: ["zip"] }],
      });
      if (!dest) return false;
      await invoke<void>("export_canvas", { id: canvas.id, dest });
      return true;
    },
    async importCanvases(projectId) {
      const picked = await open({
        title: t("导入画布"),
        multiple: true,
        filters: [{ name: t("画布包或 JSON Canvas"), extensions: ["zip", "canvas"] }],
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return [];
      return invoke<CanvasMeta[]>("import_canvases", { projectId, paths });
    },

    listTrash: () => invoke<TrashItem[]>("list_trash"),
    restoreTrash: (items) => invoke<{ canvases: CanvasMeta[]; assets: Asset[] }>("restore_trash", { items }),
    purgeTrash: (items) => invoke<void>("purge_trash", { items }),
    emptyTrash: () => invoke<void>("empty_trash"),

    calendarDays: (from, to) => invoke<CanvasDay[]>("calendar_days", { from, to }),
    search: (query) => invoke<SearchHit[]>("search", { query }),
  };
}
