import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Asset, CanvasDay, CanvasMeta, Project, SearchHit, WorkspaceInfo } from "@/types/model";
import type { Backend } from "./backend";

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
      const dir = await open({ directory: true, title: "选择或新建一个文件夹作为栖页工作区" });
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
    async importBlobs(files) {
      const out: Asset[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        out.push(await invoke<Asset>("import_bytes", { name: f.name || "粘贴的图片.png", bytes: Array.from(bytes) }));
      }
      return out;
    },
    listAssets: () => invoke<Asset[]>("list_assets"),
    assetUrl: (asset) => convertFileSrc(`${root}\\${asset.path.replaceAll("/", "\\")}`),
    openAsset: (asset) => invoke<void>("open_asset", { id: asset.id }),

    calendarDays: (from, to) => invoke<CanvasDay[]>("calendar_days", { from, to }),
    search: (query) => invoke<SearchHit[]>("search", { query }),
  };
}
