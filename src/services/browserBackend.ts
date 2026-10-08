import { t } from "@/i18n";
import { toLocalDate } from "@/lib/date";
import { uuidv7 } from "@/lib/id";
import type { Asset, CanvasDay, CanvasMeta, ID, Project, SearchHit, TrashItem, WorkspaceInfo } from "@/types/model";
import { PROJECT_COLORS } from "@/types/model";
import type { Backend, CopyPayload } from "./backend";

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
  /** 回收站；早期保存的数据里没有这一项 */
  trash?: {
    canvases: (CanvasMeta & { deletedAt: number })[];
    assets: (Asset & { deletedAt: number })[];
  };
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
  const trash = (state.trash ??= { canvases: [], assets: [] });
  const blobUrls = new Map<ID, string>();
  let copied: CopyPayload | null = null;

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // 配额不足时静默失败：预览模式不保证持久化
    }
  };

  const findCanvas = (id: ID) => {
    const c = state.canvases.find((c) => c.id === id);
    if (!c) throw new Error(t("画布不存在：{id}", { id }));
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
      state.workspace = { path: "browser://lattira", name: t("浏览器预览工作区"), isNew: true };
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
      if (!p) throw new Error(t("项目不存在：{id}", { id }));
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
    /** 移到回收站：画布内容和日历记录保留，恢复时原样放回 */
    async deleteCanvas(id) {
      const c = findCanvas(id);
      state.canvases = state.canvases.filter((x) => x.id !== id);
      trash.canvases.push({ ...c, deletedAt: Date.now() });
      delete state.texts[id];
      delete state.assetRefs[id];
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
      throw new Error(t("浏览器预览模式不支持按路径导入"));
    },
    async importTree() {
      throw new Error(t("浏览器预览模式不支持按路径导入"));
    },
    async importBlobs(files) {
      const out: Asset[] = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const hash = await sha256(buf);
        let asset = state.assets.find((a) => a.hash === hash);
        if (!asset) {
          const name = f.name || t("粘贴的图片.png");
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

    assetPath() {
      return "";
    },
    async revealAsset() {
      throw new Error(t("浏览器预览模式下无法打开资源管理器"));
    },
    async revealCanvas() {
      throw new Error(t("浏览器预览模式下无法打开资源管理器"));
    },
    async revealProject() {
      throw new Error(t("浏览器预览模式下无法打开资源管理器"));
    },
    async revealWorkspace() {
      throw new Error(t("浏览器预览模式下无法打开资源管理器"));
    },
    async renameAsset(asset, name) {
      const a = state.assets.find((x) => x.id === asset.id);
      if (!a) throw new Error(t("资源不存在：{id}", { id: asset.id }));
      const trimmed = name.trim();
      const ext = a.name.includes(".") ? a.name.slice(a.name.lastIndexOf(".")) : "";
      a.name = trimmed.includes(".") ? trimmed : trimmed + ext;
      persist();
      return { ...a, refCount: asset.refCount };
    },
    async saveAssetCopy(asset) {
      const url = blobUrls.get(asset.id);
      if (!url) return false;
      const a = document.createElement("a");
      a.href = url;
      a.download = asset.name;
      a.click();
      return true;
    },
    async deleteAssets(ids) {
      const gone = new Set(ids);
      const canvasIds: ID[] = [];
      let removedCards = 0;
      for (const [canvasId, refs] of Object.entries(state.assetRefs)) {
        if (!refs.some((id) => gone.has(id))) continue;
        const raw = localStorage.getItem(contentKey(canvasId));
        if (raw) {
          const doc = JSON.parse(raw) as { nodes: { id: string; lattira?: { assetId?: string } }[]; edges: { fromNode: string; toNode: string }[] };
          const removed = new Set(doc.nodes.filter((n) => n.lattira?.assetId && gone.has(n.lattira.assetId)).map((n) => n.id));
          doc.nodes = doc.nodes.filter((n) => !removed.has(n.id));
          doc.edges = doc.edges.filter((e) => !removed.has(e.fromNode) && !removed.has(e.toNode));
          localStorage.setItem(contentKey(canvasId), JSON.stringify(doc, null, 2));
          removedCards += removed.size;
          const c = state.canvases.find((x) => x.id === canvasId);
          if (c) c.elementCount = doc.nodes.length;
          canvasIds.push(canvasId);
        }
        state.assetRefs[canvasId] = refs.filter((id) => !gone.has(id));
      }
      const now = Date.now();
      for (const a of state.assets) if (gone.has(a.id)) trash.assets.push({ ...a, deletedAt: now });
      state.assets = state.assets.filter((a) => !gone.has(a.id));
      persist();
      return { canvasIds, removedCards };
    },
    // 浏览器无法写入文件剪贴板：只复制纯文本，卡片数据留在内存里供本页粘贴
    async copyCards(payload) {
      copied = payload;
      if (payload.plainText.trim()) await navigator.clipboard.writeText(payload.plainText).catch(() => {});
    },
    async readClipboard() {
      return { cards: copied?.cards ?? null, files: [], text: null };
    },
    subscribeAssetUpdates() {
      return () => {};
    },

    async exportCanvas(canvas) {
      // 浏览器里拿不到文件本体，只导出画布文件本身
      const content = localStorage.getItem(contentKey(canvas.id)) ?? "";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      a.download = `${canvas.title}.canvas`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    },
    async importCanvases(projectId) {
      const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".canvas";
        input.multiple = true;
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.oncancel = () => resolve([]);
        input.click();
      });
      const out: CanvasMeta[] = [];
      for (const f of files) {
        const doc = JSON.parse(await f.text()) as { nodes?: Record<string, unknown>[]; edges?: unknown[] };
        // 引用的文件不在本工作区时，变成写着原路径的文本卡片
        for (const n of doc.nodes ?? []) {
          const lattira = n.lattira as { assetId?: ID } | undefined;
          if (n.type === "file" && !state.assets.some((a) => a.id === lattira?.assetId)) {
            Object.assign(n, { type: "text", text: t("找不到文件：{file}", { file: String(n.file ?? "") }), lattira: undefined });
          }
        }
        const now = Date.now();
        const c: CanvasMeta = {
          id: uuidv7(),
          projectId,
          title: f.name.replace(/\.canvas$/i, "") || t("导入的画布"),
          elementCount: doc.nodes?.length ?? 0,
          createdAt: now,
          updatedAt: now,
        };
        localStorage.setItem(contentKey(c.id), JSON.stringify({ nodes: doc.nodes ?? [], edges: doc.edges ?? [] }, null, 2));
        state.canvases.push(c);
        out.push({ ...c });
      }
      persist();
      return out;
    },

    async listTrash() {
      const items: TrashItem[] = [
        ...trash.canvases.map((c) => ({
          kind: "canvas" as const,
          id: c.id,
          name: c.title,
          deletedAt: c.deletedAt,
          size: (localStorage.getItem(contentKey(c.id)) ?? "").length,
          projectId: c.projectId,
          elementCount: c.elementCount,
          preview: c.preview,
        })),
        ...trash.assets.map((a) => ({ kind: "asset" as const, id: a.id, name: a.name, deletedAt: a.deletedAt, size: a.size, mime: a.mime })),
      ];
      return items.sort((a, b) => b.deletedAt - a.deletedAt);
    },
    async restoreTrash(items) {
      const canvases: CanvasMeta[] = [];
      const assets: Asset[] = [];
      for (const item of items) {
        if (item.kind === "canvas") {
          const c = trash.canvases.find((x) => x.id === item.id);
          if (!c) continue;
          trash.canvases = trash.canvases.filter((x) => x.id !== item.id);
          const { deletedAt: _, ...meta } = c;
          // 原项目已归档时放进「未分类」
          const project = state.projects.find((p) => p.id === meta.projectId);
          if (!project || project.archived) meta.projectId = state.projects.find((p) => p.isInbox)!.id;
          state.canvases.push(meta);
          canvases.push({ ...meta });
        } else {
          const a = trash.assets.find((x) => x.id === item.id);
          if (!a) continue;
          trash.assets = trash.assets.filter((x) => x.id !== item.id);
          const { deletedAt: _, ...asset } = a;
          const existing = state.assets.find((x) => x.hash === asset.hash);
          if (!existing) state.assets.push(asset);
          assets.push({ ...(existing ?? asset), refCount: 0 });
        }
      }
      persist();
      return { canvases, assets };
    },
    async purgeTrash(items) {
      for (const item of items) {
        if (item.kind === "canvas") {
          if (!trash.canvases.some((c) => c.id === item.id)) continue;
          trash.canvases = trash.canvases.filter((c) => c.id !== item.id);
          state.days = state.days.filter((d) => d.canvasId !== item.id);
          localStorage.removeItem(contentKey(item.id));
        } else {
          trash.assets = trash.assets.filter((a) => a.id !== item.id);
          blobUrls.delete(item.id);
        }
      }
      persist();
    },
    async emptyTrash() {
      await this.purgeTrash([
        ...trash.canvases.map((c) => ({ kind: "canvas" as const, id: c.id })),
        ...trash.assets.map((a) => ({ kind: "asset" as const, id: a.id })),
      ]);
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
