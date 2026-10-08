import { toLocalDate } from "@/lib/date";
import { uuidv7 } from "@/lib/id";
import type { Asset, CanvasDay, CanvasMeta, ID, Project, SearchHit, WorkspaceInfo } from "@/types/model";
import { PROJECT_COLORS } from "@/types/model";
import type { Backend } from "./backend";

/**
 * 浏览器预览用的存储：数据存在 localStorage，仅用于开发界面。
 * 导入的文件只保存在内存里（blob URL），刷新页面后图片和文件内容会丢失。
 */
interface State {
  workspace: WorkspaceInfo | null;
  projects: Project[];
  canvases: CanvasMeta[];
  days: CanvasDay[];
  assets: Asset[];
  texts: Record<ID, { elementId: ID; text: string }[]>;
  assetRefs: Record<ID, ID[]>;
}

const KEY = "lattira.dev.state";
const contentKey = (id: ID) => `lattira.dev.canvas.${id}`;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // 忽略损坏的数据，从空状态开始
  }
  return { workspace: null, projects: [], canvases: [], days: [], assets: [], texts: {}, assetRefs: {} };
}

export function createBrowserBackend(): Backend {
  const state = load();
  // 早期版本叫「收件箱」
  for (const p of state.projects) if (p.isInbox && p.name === "收件箱") p.name = "未分类";
  const blobUrls = new Map<ID, string>();

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // 配额不足时静默失败：预览模式不保证持久化
    }
  };

  const findCanvas = (id: ID) => {
    const c = state.canvases.find((c) => c.id === id);
    if (!c) throw new Error(`画布不存在：${id}`);
    return c;
  };

  const withRefCounts = () =>
    state.assets.map((a) => ({
      ...a,
      refCount: Object.values(state.assetRefs).filter((ids) => ids.includes(a.id)).length,
    }));

  async function sha256(buf: ArrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function imageSize(url: string): Promise<{ width?: number; height?: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({});
      img.src = url;
    });
  }

  return {
    kind: "browser",

    async restoreWorkspace() {
      return state.workspace ? { ...state.workspace, isNew: false } : null;
    },
    async pickWorkspace() {
      const now = Date.now();
      state.workspace = { path: "browser://lattira", name: "浏览器预览工作区", isNew: true };
      if (!state.projects.some((p) => p.isInbox)) {
        state.projects.push({
          id: uuidv7(),
          name: "未分类",
          color: PROJECT_COLORS[0],
          isInbox: true,
          pinned: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        });
      }
      persist();
      return state.workspace;
    },

    async listProjects() {
      return [...state.projects];
    },
    async createProject(name, color) {
      const now = Date.now();
      const p: Project = { id: uuidv7(), name, color, isInbox: false, pinned: false, archived: false, createdAt: now, updatedAt: now };
      state.projects.push(p);
      persist();
      return { ...p };
    },
    async updateProject(id, patch) {
      const p = state.projects.find((p) => p.id === id);
      if (!p) throw new Error(`项目不存在：${id}`);
      Object.assign(p, patch, { updatedAt: Date.now() });
      persist();
      return { ...p };
    },

    async listCanvases() {
      return [...state.canvases];
    },
    async createCanvas(projectId, title) {
      const now = Date.now();
      const c: CanvasMeta = { id: uuidv7(), projectId, title, elementCount: 0, createdAt: now, updatedAt: now };
      state.canvases.push(c);
      persist();
      return { ...c };
    },
    async updateCanvas(id, patch) {
      const c = findCanvas(id);
      Object.assign(c, patch);
      persist();
      return { ...c };
    },
    async deleteCanvas(id) {
      state.canvases = state.canvases.filter((c) => c.id !== id);
      state.days = state.days.filter((d) => d.canvasId !== id);
      delete state.texts[id];
      delete state.assetRefs[id];
      localStorage.removeItem(contentKey(id));
      persist();
    },
    async loadCanvas(id) {
      findCanvas(id);
      return localStorage.getItem(contentKey(id)) ?? "";
    },
    async saveCanvas(id, content, index, changes) {
      const c = findCanvas(id);
      const now = Date.now();
      localStorage.setItem(contentKey(id), content);
      c.elementCount = index.elementCount;
      c.preview = index.preview;
      state.texts[id] = index.texts;
      state.assetRefs[id] = index.assetIds;
      const count = changes.added + changes.modified + changes.removed;
      if (count > 0) {
        c.updatedAt = now;
        const date = toLocalDate(new Date(now));
        const day = state.days.find((d) => d.canvasId === id && d.date === date);
        if (day) day.changeCount += count;
        else state.days.push({ canvasId: id, date, changeCount: count });
      }
      persist();
      return { ...c };
    },

    async importPaths() {
      throw new Error("浏览器预览模式不支持按路径导入");
    },
    async importBlobs(files) {
      const out: Asset[] = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const hash = await sha256(buf);
        let asset = state.assets.find((a) => a.hash === hash);
        if (!asset) {
          const name = f.name || "粘贴的图片.png";
          asset = {
            id: uuidv7(),
            hash,
            path: `assets/${toLocalDate(new Date()).slice(0, 7)}/${name}`,
            name,
            mime: f.type || "application/octet-stream",
            size: f.size,
            importedAt: Date.now(),
            refCount: 0,
          };
          state.assets.push(asset);
        }
        if (!blobUrls.has(asset.id)) blobUrls.set(asset.id, URL.createObjectURL(f));
        if (asset.mime.startsWith("image/") && asset.width === undefined) {
          Object.assign(asset, await imageSize(blobUrls.get(asset.id)!));
        }
        out.push(asset);
      }
      persist();
      return out;
    },
    async listAssets() {
      return withRefCounts();
    },
    assetUrl(asset) {
      return blobUrls.get(asset.id) ?? "";
    },
    async openAsset(asset) {
      const url = blobUrls.get(asset.id);
      if (url) window.open(url, "_blank");
    },

    subscribeAssetUpdates() {
      return () => {};
    },

    async calendarDays(from, to) {
      const alive = new Set(state.canvases.map((c) => c.id));
      return state.days.filter((d) => d.date >= from && d.date <= to && alive.has(d.canvasId));
    },
    async search(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const hits: SearchHit[] = [];
      for (const c of state.canvases) {
        if (c.title.toLowerCase().includes(q)) {
          hits.push({ kind: "canvas", canvasId: c.id, canvasTitle: c.title, projectId: c.projectId, snippet: c.title });
        }
        for (const t of state.texts[c.id] ?? []) {
          if (t.text.toLowerCase().includes(q)) {
            hits.push({ kind: "text", canvasId: c.id, canvasTitle: c.title, projectId: c.projectId, elementId: t.elementId, snippet: t.text.slice(0, 120) });
          }
        }
        for (const assetId of state.assetRefs[c.id] ?? []) {
          const a = state.assets.find((a) => a.id === assetId);
          if (a?.name.toLowerCase().includes(q)) {
            hits.push({ kind: "file", canvasId: c.id, canvasTitle: c.title, projectId: c.projectId, snippet: a.name });
          }
        }
      }
      return hits.slice(0, 50);
    },
  };
}
