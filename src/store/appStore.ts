import { create } from "zustand";
import { backend, type CanvasPatch, type ProjectPatch } from "@/services/backend";
import { seedWelcomeCanvas } from "@/features/workspace/seed";
import type { Asset, CanvasMeta, ID, Project, WorkspaceInfo } from "@/types/model";
import { PROJECT_COLORS } from "@/types/model";

export type View =
  | { kind: "project"; projectId: ID }
  | { kind: "canvas"; canvasId: ID; focusElementId?: ID; focusAssetId?: ID }
  | { kind: "recent" }
  | { kind: "calendar" }
  | { kind: "assets" };

interface AppState {
  status: "loading" | "no-workspace" | "ready";
  workspace: WorkspaceInfo | null;
  projects: Project[];
  canvases: CanvasMeta[];
  assets: ReadonlyMap<ID, Asset>;
  view: View;
  searchOpen: boolean;
  inspectorOpen: boolean;
  minimapOpen: boolean;
  toast: string | null;

  init(): Promise<void>;
  pickWorkspace(): Promise<void>;
  navigate(view: View): void;
  setSearchOpen(open: boolean): void;
  toggleInspector(): void;
  toggleMinimap(): void;
  showToast(message: string): void;

  createProject(name: string): Promise<Project>;
  updateProject(id: ID, patch: ProjectPatch): Promise<void>;

  createCanvas(projectId: ID, title?: string): Promise<CanvasMeta>;
  updateCanvas(id: ID, patch: CanvasPatch): Promise<void>;
  deleteCanvas(id: ID): Promise<void>;
  /** 画布保存后由 canvasStore 回调，更新列表中的元信息 */
  canvasSaved(meta: CanvasMeta): void;

  addAssets(assets: Asset[]): void;
  refreshAssets(): Promise<void>;
}

const toMap = (assets: Asset[]) => new Map(assets.map((a) => [a.id, a]));

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // 存储不可用时只影响本次会话
  }
}

let unsubscribeAssets: (() => void) | undefined;

export const inboxOf = (projects: Project[]) => projects.find((p) => p.isInbox);

export const useAppStore = create<AppState>()((set, get) => {
  async function enter(ws: WorkspaceInfo) {
    const [projects, canvases, assets] = await Promise.all([
      backend.listProjects(),
      backend.listCanvases(),
      backend.listAssets(),
    ]);
    const inbox = inboxOf(projects);
    if (!inbox) throw new Error("工作区缺少未分类项目");

    let all = canvases;
    if (ws.isNew && canvases.length === 0) {
      // 先写好欢迎画布再进入，避免画布视图读到空文件
      const meta = await backend.createCanvas(inbox.id, "欢迎使用栖页");
      all = [await seedWelcomeCanvas(meta.id)];
    }
    const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    set({
      workspace: ws,
      projects,
      canvases: all,
      assets: toMap(assets),
      status: "ready",
      view: latest ? { kind: "canvas", canvasId: latest.id } : { kind: "project", projectId: inbox.id },
    });
    // 后台 OCR 识别完一张图片后刷新资源信息
    unsubscribeAssets?.();
    unsubscribeAssets = backend.subscribeAssetUpdates(() => void get().refreshAssets());
  }

  return {
    status: "loading",
    workspace: null,
    projects: [],
    canvases: [],
    assets: new Map(),
    view: { kind: "calendar" },
    searchOpen: false,
    inspectorOpen: true,
    minimapOpen: readFlag("lattira.minimap", true),
    toast: null,

    async init() {
      try {
        const ws = await backend.restoreWorkspace();
        if (ws) await enter(ws);
        else set({ status: "no-workspace" });
      } catch (e) {
        set({ status: "no-workspace" });
        get().showToast(`打开上次的工作区失败：${String(e)}`);
      }
    },

    async pickWorkspace() {
      try {
        const ws = await backend.pickWorkspace();
        if (ws) await enter(ws);
      } catch (e) {
        get().showToast(`打开工作区失败：${String(e)}`);
      }
    },

    navigate: (view) => set({ view }),
    setSearchOpen: (searchOpen) => set({ searchOpen }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    toggleMinimap: () =>
      set((s) => {
        writeFlag("lattira.minimap", !s.minimapOpen);
        return { minimapOpen: !s.minimapOpen };
      }),

    showToast(message) {
      set({ toast: message });
      window.setTimeout(() => {
        if (get().toast === message) set({ toast: null });
      }, 4000);
    },

    async createProject(name) {
      const color = PROJECT_COLORS[get().projects.length % PROJECT_COLORS.length];
      const p = await backend.createProject(name, color);
      set((s) => ({ projects: [...s.projects, p], view: { kind: "project", projectId: p.id } }));
      return p;
    },

    async updateProject(id, patch) {
      const p = await backend.updateProject(id, patch);
      set((s) => ({ projects: s.projects.map((x) => (x.id === id ? p : x)) }));
    },

    async createCanvas(projectId, title = "未命名画布") {
      const meta = await backend.createCanvas(projectId, title);
      set((s) => ({ canvases: [...s.canvases, meta], view: { kind: "canvas", canvasId: meta.id } }));
      return meta;
    },

    async updateCanvas(id, patch) {
      const meta = await backend.updateCanvas(id, patch);
      get().canvasSaved(meta);
    },

    async deleteCanvas(id) {
      const meta = get().canvases.find((c) => c.id === id);
      await backend.deleteCanvas(id);
      set((s) => ({
        canvases: s.canvases.filter((c) => c.id !== id),
        view:
          s.view.kind === "canvas" && s.view.canvasId === id && meta
            ? { kind: "project", projectId: meta.projectId }
            : s.view,
      }));
    },

    canvasSaved(meta) {
      set((s) => ({ canvases: s.canvases.map((c) => (c.id === meta.id ? meta : c)) }));
    },

    addAssets(assets) {
      set((s) => {
        const next = new Map(s.assets);
        for (const a of assets) next.set(a.id, a);
        return { assets: next };
      });
    },

    async refreshAssets() {
      set({ assets: toMap(await backend.listAssets()) });
    },
  };
});
