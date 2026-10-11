import { create } from "zustand";
import { backend, type CanvasPatch, type ProjectPatch } from "@/services/backend";
import { seedWelcomeCanvas } from "@/features/workspace/seed";
import { t } from "@/i18n";
import { sameName, sanitizeName } from "@/lib/names";
import { commitEditors, invalidateOperations } from "@/lib/operations";
import { cancelPrompts } from "@/features/menu/PromptDialog";
import type { Asset, CanvasMeta, ID, Project, WorkspaceInfo } from "@/types/model";
import { PROJECT_COLORS } from "@/types/model";

export type View =
  | { kind: "project"; projectId: ID }
  /** findQuery：从全局搜索跳过来时，打开画布内查找并高亮这个词 */
  | { kind: "canvas"; canvasId: ID; focusElementId?: ID; focusAssetId?: ID; findQuery?: string }
  | { kind: "recent" }
  | { kind: "calendar" }
  | { kind: "assets" }
  | { kind: "trash" }
  | { kind: "settings"; section?: SettingsSection };

export type SettingsSection = "general" | "workspace" | "shortcuts" | "about";

interface AppState {
  status: "loading" | "no-workspace" | "ready";
  workspace: WorkspaceInfo | null;
  projects: Project[];
  canvases: CanvasMeta[];
  assets: ReadonlyMap<ID, Asset>;
  view: View;
  /** 打开的画布标签页，按显示顺序 */
  tabs: ID[];
  searchOpen: boolean;
  inspectorOpen: boolean;
  minimapOpen: boolean;
  toast: string | null;

  init(): Promise<void>;
  pickWorkspace(): Promise<void>;
  /** 切换页面；打开画布时如果还没有它的标签页，就在当前标签页右侧新建一个 */
  navigate(view: View): void;
  /** 关闭标签页；关闭的是当前画布时切到相邻的标签页，没有了就回到它所在的项目 */
  closeTabs(ids: ID[]): void;
  /** 切到下一个（1）或上一个（-1）标签页 */
  cycleTab(delta: 1 | -1): void;
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

/** 工作区里是否已有这个名字的项目（不区分大小写；归档的和「未分类」也算） */
export function projectNameTaken(name: string, exclude?: ID): boolean {
  return useAppStore.getState().projects.some((p) => p.id !== exclude && sameName(p.name, sanitizeName(name)));
}

/** 项目里是否已有这个名字的画布 */
export function canvasTitleTaken(projectId: ID, title: string, exclude?: ID): boolean {
  return useAppStore.getState().canvases.some((c) => c.projectId === projectId && c.id !== exclude && sameName(c.title, sanitizeName(title)));
}

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

// ---- 标签页按工作区记住，下次打开时恢复 ----
interface SavedTabs {
  tabs: ID[];
  active: ID | null;
}
const tabsKey = (ws: WorkspaceInfo) => `lattira.tabs:${ws.path}`;

function readTabs(ws: WorkspaceInfo): SavedTabs {
  try {
    const raw = localStorage.getItem(tabsKey(ws));
    if (raw) return JSON.parse(raw) as SavedTabs;
  } catch {
    // 读不到时从空白开始
  }
  return { tabs: [], active: null };
}

function writeTabs(ws: WorkspaceInfo, saved: SavedTabs) {
  try {
    localStorage.setItem(tabsKey(ws), JSON.stringify(saved));
  } catch {
    // 只影响下次启动时恢复标签页
  }
}

export const inboxOf = (projects: Project[]) => projects.find((p) => p.isInbox);

/** 界面上显示的项目名：「未分类」随界面语言翻译，其余项目用自己的名字 */
export const projectLabel = (p: Pick<Project, "isInbox" | "name">) => (p.isInbox ? t("未分类") : p.name);

export const useAppStore = create<AppState>()((set, get) => {
  let navigation = 0;
  async function enter(ws: WorkspaceInfo) {
    const [projects, canvases, assets] = await Promise.all([
      backend.listProjects(),
      backend.listCanvases(),
      backend.listAssets(),
    ]);
    const inbox = inboxOf(projects);
    if (!inbox) throw new Error(t("工作区缺少未分类项目"));

    let all = canvases;
    if (ws.isNew && canvases.length === 0) {
      // 先写好欢迎画布再进入，避免画布视图读到空文件
      const meta = await backend.createCanvas(inbox.id, t("欢迎使用栖页"));
      all = [await seedWelcomeCanvas(meta.id)];
    }
    // 恢复上次打开的标签页；没有时打开最近编辑的画布
    const alive = new Set(all.map((c) => c.id));
    const saved = readTabs(ws);
    let tabs = saved.tabs.filter((id) => alive.has(id));
    let active = saved.active && tabs.includes(saved.active) ? saved.active : (tabs[0] ?? null);
    if (!active) {
      const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) {
        active = latest.id;
        tabs = [latest.id];
      }
    }
    set({
      workspace: ws,
      projects,
      canvases: all,
      assets: toMap(assets),
      status: "ready",
      tabs,
      view: active ? { kind: "canvas", canvasId: active } : { kind: "project", projectId: inbox.id },
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
    tabs: [],
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
        get().showToast(t("打开上次的工作区失败：{error}", { error: String(e) }));
      }
    },

    async pickWorkspace() {
      let switched = false;
      try {
        const { useCanvasStore } = await import("./canvasStore");
        await useCanvasStore.getState().flush();
        const ws = await backend.pickWorkspace();
        if (ws) {
          switched = true; navigation++;
          invalidateOperations(); cancelPrompts(); useCanvasStore.getState().reset();
          set({ status: "loading", workspace: ws, searchOpen: false });
          await enter(ws);
        }
      } catch (e) {
        if (switched) set({ status: "no-workspace", workspace: null, tabs: [], projects: [], canvases: [], assets: new Map() });
        get().showToast(t("打开工作区失败：{error}", { error: String(e) }));
      }
    },

    navigate: (view) => {
      const request = ++navigation;
      commitEditors();
      void import("./canvasStore").then(async ({ useCanvasStore }) => {
        await useCanvasStore.getState().flush();
        if (request !== navigation) return;
        set((s) => {
        if (view.kind !== "canvas" || s.tabs.includes(view.canvasId)) return { view };
        const at = s.view.kind === "canvas" ? s.tabs.indexOf(s.view.canvasId) : -1;
        const tabs = at >= 0 ? [...s.tabs.slice(0, at + 1), view.canvasId, ...s.tabs.slice(at + 1)] : [...s.tabs, view.canvasId];
        return { view, tabs };
        });
      }).catch((error) => get().showToast(t("保存失败：{error}", { error: String(error) })));
    },

    closeTabs: (ids) => {
      const request = ++navigation;
      commitEditors();
      void import("./canvasStore").then(async ({ useCanvasStore }) => {
        await useCanvasStore.getState().flush();
        if (request !== navigation) return;
        set((s) => {
        const gone = new Set(ids);
        const tabs = s.tabs.filter((id) => !gone.has(id));
        const v = s.view;
        if (v.kind !== "canvas" || !gone.has(v.canvasId)) return { tabs };
        const i = s.tabs.indexOf(v.canvasId);
        const next = s.tabs.slice(i + 1).find((id) => !gone.has(id)) ?? s.tabs.slice(0, Math.max(i, 0)).reverse().find((id) => !gone.has(id));
        const meta = s.canvases.find((c) => c.id === v.canvasId);
        const view: View = next
          ? { kind: "canvas", canvasId: next }
          : meta
            ? { kind: "project", projectId: meta.projectId }
            : { kind: "recent" };
        return { tabs, view };
        });
      }).catch((error) => get().showToast(t("保存失败：{error}", { error: String(error) })));
    },

    cycleTab(delta) {
      const { tabs, view, navigate } = get();
      if (tabs.length === 0) return;
      const at = view.kind === "canvas" ? tabs.indexOf(view.canvasId) : -1;
      const next = at < 0 ? (delta > 0 ? 0 : tabs.length - 1) : (at + delta + tabs.length) % tabs.length;
      navigate({ kind: "canvas", canvasId: tabs[next] });
    },
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
      const workspace = get().workspace;
      const p = await backend.createProject(name, color);
      if (get().workspace !== workspace) return p;
      set((s) => ({ projects: [...s.projects, p], view: { kind: "project", projectId: p.id } }));
      return p;
    },

    async updateProject(id, patch) {
      const workspace = get().workspace;
      const p = await backend.updateProject(id, patch);
      if (get().workspace !== workspace) return;
      set((s) => ({ projects: s.projects.map((x) => (x.id === id ? p : x)) }));
    },

    async createCanvas(projectId, title = t("未命名画布")) {
      const workspace = get().workspace;
      const meta = await backend.createCanvas(projectId, title);
      if (get().workspace !== workspace) return meta;
      set((s) => ({ canvases: [...s.canvases, meta] }));
      get().navigate({ kind: "canvas", canvasId: meta.id });
      return meta;
    },

    async updateCanvas(id, patch) {
      const before = get().canvases.find((c) => c.id === id);
      const workspace = get().workspace;
      const meta = await backend.updateCanvas(id, patch);
      if (get().workspace !== workspace) return;
      get().canvasSaved(meta);
      // 移到的项目里已有同名画布时，后台自动加上了「(2)」
      if (!patch.title && before && meta.title !== before.title) {
        get().showToast(t("目标项目里已有「{old}」，移过去的画布改名为「{name}」", { old: before.title, name: meta.title }));
      }
    },

    async deleteCanvas(id) {
      const { useCanvasStore } = await import("./canvasStore");
      await useCanvasStore.getState().flush();
      const meta = get().canvases.find((c) => c.id === id);
      const workspace = get().workspace;
      await backend.deleteCanvas(id);
      if (get().workspace !== workspace) return;
      if (useCanvasStore.getState().doc?.canvasId === id) useCanvasStore.getState().reset();
      if (meta) get().showToast(t("已把「{name}」移到回收站", { name: meta.title }));
      get().closeTabs([id]);
      set((s) => ({ canvases: s.canvases.filter((c) => c.id !== id) }));
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
      const workspace = get().workspace;
      const assets = await backend.listAssets();
      if (get().workspace === workspace) set({ assets: toMap(assets) });
    },
  };
});

// 标签页变化时保存；当前不在画布页时沿用上次记下的活动标签页
useAppStore.subscribe((s, prev) => {
  if (!s.workspace || (s.tabs === prev.tabs && s.view === prev.view)) return;
  const active = s.view.kind === "canvas" ? s.view.canvasId : readTabs(s.workspace).active;
  writeTabs(s.workspace, { tabs: s.tabs, active: active && s.tabs.includes(active) ? active : null });
});
