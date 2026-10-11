import { create } from "zustand";
import { arrangeAt, canMoveInto, FOLDER_H, FOLDER_W, namesAt, withDescendants } from "@/lib/folders";
import { uniqueName } from "@/lib/names";
import { boundsOf, center, type Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { fromJsonCanvas, toJsonCanvas } from "@/lib/jsonCanvas";
import { buildPreview } from "@/lib/preview";
import { backend } from "@/services/backend";
import type {
  Asset,
  CanvasDoc,
  CanvasElement,
  CanvasIndex,
  CanvasMeta,
  ChangeSummary,
  Edge,
  ID,
  FolderElement,
  LinkElement,
  Viewport,
} from "@/types/model";
import { t } from "@/i18n";
import { bindOperationContext, commitEditors, contentHash, invalidateOperations } from "@/lib/operations";
import { useAppStore } from "./appStore";

/** 撤销历史与变化统计只关心元素和连线；视口变化不算编辑 */
interface Snapshot {
  elements: CanvasElement[];
  edges: Edge[];
}

export type ElementPatch = Partial<Omit<CanvasElement, "id" | "type">> & { text?: string; label?: string; assetId?: ID } & Partial<
  Omit<LinkElement, "id" | "type">
>;

type SaveState = "saved" | "pending" | "saving" | "error";

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

interface CanvasState {
  /** 画布内容；其中的 viewport 只在加载和保存时使用，平时以下面的 viewport 为准 */
  doc: CanvasDoc | null;
  /** 单独存放，平移缩放时不会让依赖 doc 的组件重新渲染 */
  viewport: Viewport;
  selectedIds: ID[];
  selectedEdgeId: ID | null;
  editingId: ID | null;
  /** 正在大窗口中编辑的文本卡片 */
  editorId: ID | null;
  /** 请求画布把某个元素移到视口中央；n 递增以便重复定位同一元素；select 为 false 时只定位不选中 */
  focusRequest: { id: ID; n: number; select: boolean } | null;
  /** 打开着的文件夹窗口；focusIds 是要在窗口里选中、定位并闪一下的元素，n 递增以便重复定位 */
  folderView: { id: ID; focusIds?: ID[]; n: number } | null;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;

  load(canvasId: ID): Promise<void>;
  /** 离开画布前把未保存的修改写盘 */
  flush(): Promise<void>;
  reset(): void;
  recover(): Promise<void>;

  setViewport(vp: Viewport): void;
  select(ids: ID[], additive?: boolean): void;
  selectEdge(id: ID | null): void;
  setEditing(id: ID | null): void;

  addElements(elements: CanvasElement[], opts?: { select?: boolean; edit?: boolean }): void;
  /** 粘贴：一次插入一批元素和它们之间的连线，并选中这些元素 */
  insertCards(elements: CanvasElement[], edges: Edge[]): void;
  updateElements(patches: Record<ID, ElementPatch>): void;
  /**
   * 后台补充的信息（如链接预览）：不进撤销历史，同时补到历史快照里，撤销其他操作时不会丢。
   * 画布不在编辑中时改写后台标签页的缓存或磁盘上的文件。
   */
  patchQuietly(canvasId: ID, patches: Record<ID, ElementPatch>, expectedUrl?: string): Promise<void>;
  deleteSelection(): void;
  /** 删除元素；删除文件夹时连同里面的内容 */
  deleteElements(ids: ID[]): void;
  addEdge(fromId: ID, toId: ID): void;
  reverseEdge(id: ID): void;
  /** 把选中的卡片放进一个新文件夹，文件夹放在它们原来的位置 */
  groupSelection(): void;
  /**
   * 把元素放进文件夹（排在已有内容后面）；不能把文件夹放进它自己或它里面的文件夹，这时返回 false。
   * patches：同时要改的内容（重名时改的名字），与移动记为同一步撤销。重名检查见 features/canvas/cardNames.ts
   */
  moveIntoFolder(ids: ID[], folderId: ID, patches?: Record<ID, ElementPatch>): boolean;
  /** 把文件夹里的元素拿到画布上，第一个的中心对准 at，其余依次排开 */
  moveToCanvas(ids: ID[], at: Point, patches?: Record<ID, ElementPatch>): void;
  /** 解散文件夹：里面的内容放到文件夹原来的位置（文件夹在别的文件夹里时，放进那个文件夹），删除文件夹 */
  dissolveFolder(folderId: ID, patches?: Record<ID, ElementPatch>): void;
  openFolder(id: ID | null, focus?: ID | ID[]): void;
  /** 刚放进文件夹 folderId 的元素：那个文件夹的窗口开着时在窗口里选中它们 */
  showInOpenFolder(folderId: ID, ids: ID[]): void;
  /** 调整叠放次序（分组框始终在普通卡片之下） */
  reorder(ids: ID[], where: "front" | "back"): void;
  align(ids: ID[], mode: AlignMode): void;
  distribute(ids: ID[], axis: "x" | "y"): void;

  openEditor(id: ID): void;
  closeEditor(): void;
  requestFocus(id: ID, opts?: { select?: boolean }): void;

  /** 拖动、缩放等连续手势：开始时记一次历史，过程中的更新不进历史 */
  beginGesture(): void;
  updateDuringGesture(patches: Record<ID, ElementPatch>): void;
  endGesture(): void;
  /** 放弃手势中的修改，恢复到手势开始时，不记历史 */
  cancelGesture(): void;

  undo(): void;
  redo(): void;
}

const HISTORY_LIMIT = 200;
const SAVE_DELAY = 800;

// 这些状态不需要触发界面更新，放在 store 之外
let past: Snapshot[] = [];
let future: Snapshot[] = [];
let lastSaved: Snapshot = { elements: [], edges: [] };
let gestureBase: Snapshot | null = null;
let saveTimer: number | undefined;
let savingPromise: Promise<void> | null = null;
let loadSeq = 0;

/** 后台标签页的画布：切回来时原样恢复，撤销历史和选中状态都还在 */
interface CachedCanvas {
  doc: CanvasDoc;
  viewport: Viewport;
  selectedIds: ID[];
  past: Snapshot[];
  future: Snapshot[];
  lastSaved: Snapshot;
}
const cache = new Map<ID, CachedCanvas>();
const diskHashes = new Map<ID, string>();
let dirty = false;
let contentDirty = false;
let epoch = 0;
const MAX_CACHED = 6;

function trimHistory(list: Snapshot[]): Snapshot[] {
  let cost = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    cost += list[i].elements.length + list[i].edges.length;
    if (cost > 100_000) return list.slice(i + 1);
  }
  return list.slice(-HISTORY_LIMIT);
}

/** 画布文件被别处改过（例如删除资源时移除了卡片）后调用，下次打开时重新从磁盘读取 */
export function dropCanvasCache(ids: ID[]) {
  for (const id of ids) cache.delete(id);
}

const snapshotOf = (doc: CanvasDoc): Snapshot => ({ elements: doc.elements, edges: doc.edges });

function diff(prev: Snapshot, next: Snapshot): ChangeSummary {
  const prevEls = new Map(prev.elements.map((e) => [e.id, e]));
  const nextEls = new Map(next.elements.map((e) => [e.id, e]));
  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e]));
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const [id, el] of nextEls) {
    const old = prevEls.get(id);
    if (!old) added++;
    else if (old !== el) modified++;
  }
  for (const id of prevEls.keys()) if (!nextEls.has(id)) removed++;
  for (const [id, edge] of nextEdges) {
    if (!prevEdges.has(id)) added++;
    else if (JSON.stringify(prevEdges.get(id)) !== JSON.stringify(edge)) modified++;
  }
  for (const id of prevEdges.keys()) if (!nextEdges.has(id)) removed++;
  return { added, modified, removed };
}

function indexOf(doc: CanvasDoc, assets: ReadonlyMap<ID, Asset>): CanvasIndex {
  const texts: CanvasIndex["texts"] = [];
  const assetIds = new Set<ID>();
  for (const el of doc.elements) {
    if (el.type === "text" && el.text.trim()) texts.push({ elementId: el.id, text: el.text });
    if (el.type === "folder" && el.label.trim()) texts.push({ elementId: el.id, text: el.label });
    if (el.type === "link") texts.push({ elementId: el.id, text: linkText(el) });
    if (el.type === "image" || el.type === "file") assetIds.add(el.assetId);
  }
  return { elementCount: doc.elements.length, texts, assetIds: [...assetIds], preview: buildPreview(doc, assets) };
}

/** 链接卡片可被搜索的文字：标题、网址、网站名、简介 */
export const linkText = (el: LinkElement) => [el.title, el.url, el.siteName, el.description].filter(Boolean).join("\n");

/** 历史快照里的同一元素也打上补丁 */
function patchSnapshots(list: Snapshot[], patches: Record<ID, ElementPatch>): Snapshot[] {
  return list.map((snap) =>
    snap.elements.some((e) => patches[e.id])
      ? { ...snap, elements: snap.elements.map((e) => (patches[e.id] ? ({ ...e, ...patches[e.id] } as CanvasElement) : e)) }
      : snap,
  );
}

function applyPatches(elements: CanvasElement[], patches: Record<ID, ElementPatch>, now: number): CanvasElement[] {
  return elements.map((el) => {
    const p = patches[el.id];
    return p ? ({ ...el, ...p, updatedAt: now } as CanvasElement) : el;
  });
}

/** 撤销、重做后，选中的元素可能已经不在画布上（被删除或放进了文件夹） */
function keepOnCanvas(ids: ID[], elements: CanvasElement[]): ID[] {
  const shown = new Set(elements.filter((e) => !e.parentId).map((e) => e.id));
  return ids.filter((id) => shown.has(id));
}

export const useCanvasStore = create<CanvasState>()((set, get) => {
  /** 带历史的修改 */
  function commit(next: (s: Snapshot) => Snapshot) {
    const { doc } = get();
    if (!doc) return;
    const before = snapshotOf(doc);
    const after = next(before);
    if (after === before) return;
    past = trimHistory([...past, before]);
    future = [];
    set({ doc: { ...doc, ...after }, canUndo: past.length > 0, canRedo: false });
    scheduleSave();
  }

  function scheduleSave() {
    dirty = contentDirty = true;
    set({ saveState: "pending" });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save().catch(() => {}), SAVE_DELAY);
  }

  async function save() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    if (savingPromise) return savingPromise;
    const scope = epoch;
    const run = async () => { while (dirty && get().doc && scope === epoch) {
      const doc = get().doc!;
      const current = snapshotOf(doc);
      const changes = diff(lastSaved, current);
      const rebuild = contentDirty;
      dirty = contentDirty = false;
      set({ saveState: "saving" });
      try {
        const { assets } = useAppStore.getState();
        const content = toJsonCanvas({ ...doc, viewport: get().viewport }, assets);
        const meta = await backend.saveCanvas(doc.canvasId, content, rebuild ? indexOf(doc, assets) : null, changes, diskHashes.get(doc.canvasId));
        diskHashes.set(doc.canvasId, await contentHash(content));
        if (scope !== epoch) return;
        lastSaved = current;
        useAppStore.getState().canvasSaved(meta);
        if (rebuild) void useAppStore.getState().refreshAssets().catch(console.error);
        if (!dirty) set({ saveState: "saved" });
      } catch (e) {
        dirty = true;
        contentDirty ||= rebuild;
        set({ saveState: "error" });
        useAppStore.getState().showToast(t("保存失败：{error}", { error: String(e) }));
        throw e;
      }
    }};
    savingPromise = run();
    try { await savingPromise; } finally { savingPromise = null; }
  }

  return {
    doc: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedIds: [],
    selectedEdgeId: null,
    editingId: null,
    editorId: null,
    focusRequest: null,
    folderView: null,
    saveState: "saved",
    canUndo: false,
    canRedo: false,

    async load(canvasId) {
      const seq = ++loadSeq;
      await get().flush();
      // 连续快速切换标签页时，只有最后一次切换生效
      if (seq !== loadSeq) return;
      const current = get();
      if (current.doc && current.doc.canvasId !== canvasId && useAppStore.getState().tabs.includes(current.doc.canvasId)) {
        cache.set(current.doc.canvasId, {
          doc: current.doc,
          viewport: current.viewport,
          selectedIds: current.selectedIds,
          past,
          future,
          lastSaved,
        });
        while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      const cached = cache.get(canvasId);
      const content = await backend.loadCanvas(canvasId);
      const hash = await contentHash(content);
      if (seq !== loadSeq) return;
      if (cached && diskHashes.get(canvasId) === hash) {
        cache.delete(canvasId);
        ({ past, future, lastSaved } = cached);
        set({
          doc: cached.doc,
          viewport: cached.viewport,
          selectedIds: cached.selectedIds,
          selectedEdgeId: null,
          editingId: null,
          editorId: null,
          focusRequest: null,
          folderView: null,
          saveState: "saved",
          canUndo: past.length > 0,
          canRedo: future.length > 0,
        });
        return;
      }
      cache.delete(canvasId);
      diskHashes.set(canvasId, hash);
      const doc = fromJsonCanvas(content, canvasId);
      past = [];
      future = [];
      lastSaved = snapshotOf(doc);
      set({
        doc,
        viewport: doc.viewport,
        selectedIds: [],
        selectedEdgeId: null,
        editingId: null,
        editorId: null,
        focusRequest: null,
        folderView: null,
        saveState: "saved",
        canUndo: false,
        canRedo: false,
      });
    },

    async flush() {
      commitEditors();
      if (savingPromise) await savingPromise;
      if (dirty || saveTimer !== undefined) await save();
    },

    reset() {
      epoch++; loadSeq++;
      window.clearTimeout(saveTimer); saveTimer = undefined;
      cache.clear(); diskHashes.clear(); past = []; future = [];
      dirty = contentDirty = false; gestureBase = null;
      lastSaved = { elements: [], edges: [] };
      set({ doc: null, editingId: null, editorId: null, folderView: null, selectedIds: [], saveState: "saved", canUndo: false, canRedo: false });
    },

    setViewport(viewport) {
      if (!get().doc) return;
      set({ viewport });
      dirty = true;
      // 视口只需要随下一次保存落盘，不单独计入编辑
      if (saveTimer === undefined && get().saveState === "saved") {
        saveTimer = window.setTimeout(() => void save().catch(() => {}), SAVE_DELAY * 3);
      }
    },

    select(ids, additive = false) {
      set((s) => {
        if (!additive) return { selectedIds: ids, selectedEdgeId: null };
        const next = new Set(s.selectedIds);
        for (const id of ids) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return { selectedIds: [...next], selectedEdgeId: null };
      });
    },

    selectEdge: (id) => set({ selectedEdgeId: id, selectedIds: [] }),
    setEditing: (editingId) => set({ editingId }),

    addElements(elements, opts = {}) {
      commit((s) => ({ ...s, elements: [...s.elements, ...elements] }));
      if (opts.select !== false) set({ selectedIds: elements.filter((e) => !e.parentId).map((e) => e.id), selectedEdgeId: null });
      if (opts.edit && elements.length === 1) set({ editingId: elements[0].id });
    },

    insertCards(elements, edges) {
      if (elements.length === 0) return;
      commit((s) => ({ elements: [...s.elements, ...elements], edges: [...s.edges, ...edges] }));
      set({ selectedIds: elements.filter((e) => !e.parentId).map((e) => e.id), selectedEdgeId: null });
    },

    updateElements(patches) {
      const now = Date.now();
      commit((s) => ({ ...s, elements: applyPatches(s.elements, patches, now) }));
    },

    async recover() {
      commitEditors();
      if (savingPromise) await savingPromise.catch(() => {});
      const { doc, viewport } = get();
      if (!doc) return;
      await backend.saveRecovery(doc.canvasId, toJsonCanvas({ ...doc, viewport }, useAppStore.getState().assets));
      get().reset();
      await get().load(doc.canvasId);
      useAppStore.getState().showToast(t("本地内容已另存，已重新打开磁盘上的画布"));
    },

    async patchQuietly(canvasId, patches, expectedUrl) {
      const { doc } = get();
      if (doc?.canvasId === canvasId) {
        if (expectedUrl && !doc.elements.some((e) => patches[e.id] && e.type === "link" && e.url === expectedUrl)) return;
        if (!doc.elements.some((e) => patches[e.id])) return;
        past = patchSnapshots(past, patches);
        future = patchSnapshots(future, patches);
        if (gestureBase) gestureBase = patchSnapshots([gestureBase], patches)[0];
        set({ doc: { ...doc, elements: applyPatches(doc.elements, patches, Date.now()) } });
        scheduleSave();
        return;
      }
      const cached = cache.get(canvasId);
      const scope = epoch;
      const raw = await backend.loadCanvas(canvasId);
      if (scope !== epoch) return;
      if (get().doc?.canvasId === canvasId) return get().patchQuietly(canvasId, patches, expectedUrl);
      const target = cached && diskHashes.get(canvasId) === await contentHash(raw) ? cached.doc : fromJsonCanvas(raw, canvasId);
      if (expectedUrl && !target.elements.some((e) => patches[e.id] && e.type === "link" && e.url === expectedUrl)) return;
      if (!target.elements.some((e) => patches[e.id])) return;
      const next = { ...target, elements: applyPatches(target.elements, patches, Date.now()) };
      const { assets } = useAppStore.getState();
      const viewport = cached?.viewport ?? next.viewport;
      const meta = await backend.saveCanvas(canvasId, toJsonCanvas({ ...next, viewport }, assets), indexOf(next, assets), {
        added: 0,
        modified: 1,
        removed: 0,
      }, await contentHash(raw));
      diskHashes.set(canvasId, await contentHash(toJsonCanvas({ ...next, viewport }, assets)));
      if (cached) {
        cached.doc = next;
        cached.lastSaved = snapshotOf(next);
        cached.past = patchSnapshots(cached.past, patches);
        cached.future = patchSnapshots(cached.future, patches);
      }
      useAppStore.getState().canvasSaved(meta);
    },

    deleteSelection() {
      const { selectedIds, selectedEdgeId } = get();
      if (selectedEdgeId) {
        commit((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selectedEdgeId) }));
        set({ selectedEdgeId: null });
        return;
      }
      get().deleteElements(selectedIds);
    },

    deleteElements(ids) {
      const { doc } = get();
      if (!doc || ids.length === 0) return;
      const gone = withDescendants(doc.elements, ids);
      commit((s) => ({
        elements: s.elements.filter((e) => !gone.has(e.id)),
        edges: s.edges.filter((e) => !gone.has(e.fromId) && !gone.has(e.toId)),
      }));
      set((s) => ({
        selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
        editingId: null,
        folderView: s.folderView && gone.has(s.folderView.id) ? null : s.folderView,
      }));
    },

    addEdge(fromId, toId) {
      if (fromId === toId) return;
      const exists = get().doc?.edges.some((e) => e.fromId === fromId && e.toId === toId);
      if (exists) return;
      const edge: Edge = { id: uuidv7(), fromId, toId };
      commit((s) => ({ ...s, edges: [...s.edges, edge] }));
      set({ selectedEdgeId: edge.id, selectedIds: [] });
    },

    reverseEdge(id) {
      commit((s) => ({
        ...s,
        edges: s.edges.map((e) => (e.id === id ? { ...e, fromId: e.toId, toId: e.fromId, fromSide: e.toSide, toSide: e.fromSide } : e)),
      }));
    },

    moveIntoFolder(ids, folderId, patches = {}) {
      const { doc } = get();
      const folder = doc?.elements.find((e) => e.id === folderId);
      if (!doc || folder?.type !== "folder" || ids.length === 0) return false;
      if (!canMoveInto(doc.elements, ids, folderId)) return false;
      const moving = new Set(ids.filter((id) => doc.elements.some((e) => e.id === id && e.parentId !== folderId)));
      if (moving.size === 0) return true;
      const now = Date.now();
      // 放进去的排在文件夹内容的最后
      commit((s) => ({
        ...s,
        elements: [
          ...s.elements.filter((e) => !moving.has(e.id)),
          ...s.elements
            .filter((e) => moving.has(e.id))
            .map((e) => ({ ...e, ...patches[e.id], parentId: folderId, updatedAt: now }) as CanvasElement),
        ],
      }));
      set((s) => ({ selectedIds: s.selectedIds.filter((id) => !moving.has(id)), editingId: null }));
      return true;
    },

    moveToCanvas(ids, at, patches = {}) {
      const { doc } = get();
      if (!doc) return;
      const picked = doc.elements.filter((e) => ids.includes(e.id) && e.parentId);
      if (picked.length === 0) return;
      const spots = arrangeAt(picked, at);
      const index = new Map(picked.map((e, i) => [e.id, i]));
      const now = Date.now();
      // 拿到画布上的排在最上层
      commit((s) => ({
        ...s,
        elements: [
          ...s.elements.filter((e) => !index.has(e.id)),
          ...picked.map(
            (e) => ({ ...e, ...patches[e.id], ...spots[index.get(e.id)!], parentId: undefined, updatedAt: now }) as CanvasElement,
          ),
        ],
      }));
      set({ selectedIds: picked.map((e) => e.id), selectedEdgeId: null });
    },

    dissolveFolder(folderId, patches = {}) {
      const { doc } = get();
      const folder = doc?.elements.find((e) => e.id === folderId);
      if (!doc || !folder) return;
      const inside = doc.elements.filter((e) => e.parentId === folderId);
      const spots = arrangeAt(inside, center(folder));
      const index = new Map(inside.map((e, i) => [e.id, i]));
      const now = Date.now();
      commit((s) => ({
        elements: s.elements
          .filter((e) => e.id !== folderId)
          .map((e) =>
            index.has(e.id)
              ? ({ ...e, ...patches[e.id], ...spots[index.get(e.id)!], parentId: folder.parentId, updatedAt: now } as CanvasElement)
              : e,
          ),
        edges: s.edges.filter((e) => e.fromId !== folderId && e.toId !== folderId),
      }));
      set((s) => ({
        selectedIds: folder.parentId ? [] : inside.map((e) => e.id),
        selectedEdgeId: null,
        folderView: s.folderView?.id === folderId ? null : s.folderView,
      }));
    },

    openFolder(id, focus) {
      const focusIds = focus === undefined ? undefined : Array.isArray(focus) ? focus : [focus];
      set((s) => ({ folderView: id ? { id, focusIds, n: (s.folderView?.n ?? 0) + 1 } : null }));
    },

    showInOpenFolder(folderId, ids) {
      if (get().folderView?.id === folderId && ids.length) get().openFolder(folderId, ids);
    },

    reorder(ids, where) {
      const set_ = new Set(ids);
      commit((s) => {
        const picked = s.elements.filter((e) => set_.has(e.id));
        const rest = s.elements.filter((e) => !set_.has(e.id));
        return { ...s, elements: where === "front" ? [...rest, ...picked] : [...picked, ...rest] };
      });
    },

    align(ids, mode) {
      const { doc } = get();
      const els = doc?.elements.filter((e) => ids.includes(e.id)) ?? [];
      const b = boundsOf(els);
      if (!b || els.length < 2) return;
      const patches: Record<ID, ElementPatch> = {};
      for (const e of els) {
        if (mode === "left") patches[e.id] = { x: b.x };
        else if (mode === "hcenter") patches[e.id] = { x: b.x + (b.width - e.width) / 2 };
        else if (mode === "right") patches[e.id] = { x: b.x + b.width - e.width };
        else if (mode === "top") patches[e.id] = { y: b.y };
        else if (mode === "vcenter") patches[e.id] = { y: b.y + (b.height - e.height) / 2 };
        else patches[e.id] = { y: b.y + b.height - e.height };
      }
      get().updateElements(patches);
    },

    distribute(ids, axis) {
      const { doc } = get();
      const els = (doc?.elements.filter((e) => ids.includes(e.id)) ?? []).sort((a, b) => a[axis] - b[axis]);
      if (els.length < 3) return;
      const size = axis === "x" ? "width" : "height";
      const first = els[0];
      const last = els[els.length - 1];
      const total = els.reduce((sum, e) => sum + e[size], 0);
      const gap = (last[axis] + last[size] - first[axis] - total) / (els.length - 1);
      const patches: Record<ID, ElementPatch> = {};
      let cursor = first[axis];
      for (const e of els) {
        patches[e.id] = { [axis]: cursor };
        cursor += e[size] + gap;
      }
      get().updateElements(patches);
    },

    openEditor: (editorId) => set({ editorId, editingId: null }),
    closeEditor: () => set({ editorId: null }),
    requestFocus: (id, opts) =>
      set((s) => ({ focusRequest: { id, n: (s.focusRequest?.n ?? 0) + 1, select: opts?.select ?? true } })),

    groupSelection() {
      const { doc, selectedIds } = get();
      if (!doc || selectedIds.length === 0) return;
      const chosen = doc.elements.filter((e) => selectedIds.includes(e.id) && !e.parentId);
      const b = boundsOf(chosen);
      if (!b) return;
      const c = center(b);
      const now = Date.now();
      // 同一层里不重名：「新文件夹」已有时用「新文件夹 (2)」
      const taken = namesAt(doc.elements, undefined, useAppStore.getState().assets, t("未命名文件夹"), new Set(chosen.map((e) => e.id)));
      const folder: FolderElement = {
        id: uuidv7(),
        type: "folder",
        label: uniqueName(t("新文件夹"), taken),
        x: c.x - FOLDER_W / 2,
        y: c.y - FOLDER_H / 2,
        width: FOLDER_W,
        height: FOLDER_H,
        createdAt: now,
        updatedAt: now,
      };
      const moving = new Set(chosen.map((e) => e.id));
      commit((s) => ({
        ...s,
        elements: [
          ...s.elements.filter((e) => !moving.has(e.id)),
          folder,
          ...s.elements.filter((e) => moving.has(e.id)).map((e) => ({ ...e, parentId: folder.id, updatedAt: now })),
        ],
      }));
      set({ selectedIds: [folder.id], editingId: folder.id, selectedEdgeId: null });
    },

    beginGesture() {
      const { doc } = get();
      if (doc) gestureBase = snapshotOf(doc);
    },

    updateDuringGesture(patches) {
      const { doc } = get();
      if (!doc) return;
      set({ doc: { ...doc, elements: applyPatches(doc.elements, patches, Date.now()) } });
    },

    endGesture() {
      const { doc } = get();
      const base = gestureBase;
      gestureBase = null;
      if (!doc || !base || base.elements === doc.elements) return;
      past = trimHistory([...past, base]);
      future = [];
      set({ canUndo: true, canRedo: false });
      scheduleSave();
    },

    cancelGesture() {
      const { doc } = get();
      const base = gestureBase;
      gestureBase = null;
      if (doc && base) set({ doc: { ...doc, ...base } });
    },

    undo() {
      const { doc } = get();
      const prev = past.at(-1);
      if (!doc || !prev) return;
      past = past.slice(0, -1);
      future = [snapshotOf(doc), ...future];
      set((s) => ({
        doc: { ...doc, ...prev },
        canUndo: past.length > 0,
        canRedo: true,
        editingId: null,
        selectedIds: keepOnCanvas(s.selectedIds, prev.elements),
      }));
      scheduleSave();
    },

    redo() {
      const { doc } = get();
      const next = future[0];
      if (!doc || !next) return;
      future = future.slice(1);
      past = trimHistory([...past, snapshotOf(doc)]);
      set((s) => ({
        doc: { ...doc, ...next },
        canUndo: true,
        canRedo: future.length > 0,
        editingId: null,
        selectedIds: keepOnCanvas(s.selectedIds, next.elements),
      }));
      scheduleSave();
    },
  };
});

/**
 * 重新保存一次不在编辑中的画布（不计入编辑记录），重建搜索索引、资源引用和缩略图。
 * 用于从回收站恢复或刚导入的画布：这些信息都由前端生成。
 */
export async function reindexCanvas(canvasId: ID): Promise<CanvasMeta> {
  const raw = await backend.loadCanvas(canvasId);
  const doc = fromJsonCanvas(raw, canvasId);
  const { assets } = useAppStore.getState();
  return backend.saveCanvas(canvasId, toJsonCanvas(doc, assets), indexOf(doc, assets), { added: 0, modified: 0, removed: 0 }, await contentHash(raw));
}

// 关掉的标签页不再保留
bindOperationContext(() => {
  const app = useAppStore.getState();
  const canvasId = useCanvasStore.getState().doc?.canvasId;
  return { workspace: app.workspace?.path, canvasId, active: app.view.kind === "canvas" && app.view.canvasId === canvasId, hasFolder: (id: string) => !!useCanvasStore.getState().doc?.elements.some((e) => e.id === id && e.type === "folder") };
});
useAppStore.subscribe((s, prev) => {
  const currentId = s.view.kind === "canvas" ? s.view.canvasId : undefined;
  const previousId = prev.view.kind === "canvas" ? prev.view.canvasId : undefined;
  if (s.workspace?.path !== prev.workspace?.path || currentId !== previousId) invalidateOperations();
  if (s.tabs === prev.tabs) return;
  for (const id of cache.keys()) if (!s.tabs.includes(id)) cache.delete(id);
});

/** 退出前尽量把修改写盘 */
window.addEventListener("beforeunload", (event) => {
  commitEditors();
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});
