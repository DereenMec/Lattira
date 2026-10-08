import { create } from "zustand";
import { boundsOf } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { fromJsonCanvas, toJsonCanvas } from "@/lib/jsonCanvas";
import { buildPreview } from "@/lib/preview";
import { backend } from "@/services/backend";
import type {
  Asset,
  CanvasDoc,
  CanvasElement,
  CanvasIndex,
  ChangeSummary,
  Edge,
  ID,
  SectionElement,
  Viewport,
} from "@/types/model";
import { useAppStore } from "./appStore";

/** 撤销历史与变化统计只关心元素和连线；视口变化不算编辑 */
interface Snapshot {
  elements: CanvasElement[];
  edges: Edge[];
}

type ElementPatch = Partial<Omit<CanvasElement, "id" | "type">> & { text?: string; label?: string };

type SaveState = "saved" | "pending" | "saving" | "error";

interface CanvasState {
  /** 画布内容；其中的 viewport 只在加载和保存时使用，平时以下面的 viewport 为准 */
  doc: CanvasDoc | null;
  /** 单独存放，平移缩放时不会让依赖 doc 的组件重新渲染 */
  viewport: Viewport;
  selectedIds: ID[];
  selectedEdgeId: ID | null;
  editingId: ID | null;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;

  load(canvasId: ID): Promise<void>;
  /** 离开画布前把未保存的修改写盘 */
  flush(): Promise<void>;

  setViewport(vp: Viewport): void;
  select(ids: ID[], additive?: boolean): void;
  selectEdge(id: ID | null): void;
  setEditing(id: ID | null): void;

  addElements(elements: CanvasElement[], opts?: { select?: boolean; edit?: boolean }): void;
  updateElements(patches: Record<ID, ElementPatch>): void;
  deleteSelection(): void;
  addEdge(fromId: ID, toId: ID): void;
  groupSelection(): void;

  /** 拖动、缩放等连续手势：开始时记一次历史，过程中的更新不进历史 */
  beginGesture(): void;
  updateDuringGesture(patches: Record<ID, ElementPatch>): void;
  endGesture(): void;

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

const snapshotOf = (doc: CanvasDoc): Snapshot => ({ elements: doc.elements, edges: doc.edges });

function diff(prev: Snapshot, next: Snapshot): ChangeSummary {
  const prevEls = new Map(prev.elements.map((e) => [e.id, e]));
  const nextEls = new Map(next.elements.map((e) => [e.id, e]));
  const prevEdges = new Set(prev.edges.map((e) => e.id));
  const nextEdges = new Set(next.edges.map((e) => e.id));
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const [id, el] of nextEls) {
    const old = prevEls.get(id);
    if (!old) added++;
    else if (old !== el) modified++;
  }
  for (const id of prevEls.keys()) if (!nextEls.has(id)) removed++;
  for (const id of nextEdges) if (!prevEdges.has(id)) added++;
  for (const id of prevEdges) if (!nextEdges.has(id)) removed++;
  return { added, modified, removed };
}

function indexOf(doc: CanvasDoc, assets: ReadonlyMap<ID, Asset>): CanvasIndex {
  const texts: CanvasIndex["texts"] = [];
  const assetIds = new Set<ID>();
  for (const el of doc.elements) {
    if (el.type === "text" && el.text.trim()) texts.push({ elementId: el.id, text: el.text });
    if (el.type === "section" && el.label.trim()) texts.push({ elementId: el.id, text: el.label });
    if (el.type === "image" || el.type === "file") assetIds.add(el.assetId);
  }
  return { elementCount: doc.elements.length, texts, assetIds: [...assetIds], preview: buildPreview(doc, assets) };
}

function applyPatches(elements: CanvasElement[], patches: Record<ID, ElementPatch>, now: number): CanvasElement[] {
  return elements.map((el) => {
    const p = patches[el.id];
    return p ? ({ ...el, ...p, updatedAt: now } as CanvasElement) : el;
  });
}

export const useCanvasStore = create<CanvasState>()((set, get) => {
  /** 带历史的修改 */
  function commit(next: (s: Snapshot) => Snapshot) {
    const { doc } = get();
    if (!doc) return;
    const before = snapshotOf(doc);
    const after = next(before);
    if (after === before) return;
    past = [...past, before].slice(-HISTORY_LIMIT);
    future = [];
    set({ doc: { ...doc, ...after }, canUndo: true, canRedo: false });
    scheduleSave();
  }

  function scheduleSave() {
    set({ saveState: "pending" });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), SAVE_DELAY);
  }

  async function save() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    if (savingPromise) await savingPromise;
    const { doc } = get();
    if (!doc) return;
    const current = snapshotOf(doc);
    const changes = diff(lastSaved, current);
    set({ saveState: "saving" });
    const run = async () => {
      try {
        const { assets } = useAppStore.getState();
        const content = toJsonCanvas({ ...doc, viewport: get().viewport }, assets);
        const meta = await backend.saveCanvas(doc.canvasId, content, indexOf(doc, assets), changes);
        lastSaved = current;
        useAppStore.getState().canvasSaved(meta);
        if (get().doc?.canvasId === doc.canvasId && saveTimer === undefined) set({ saveState: "saved" });
      } catch (e) {
        set({ saveState: "error" });
        useAppStore.getState().showToast(`保存失败：${String(e)}`);
      }
    };
    savingPromise = run();
    await savingPromise;
    savingPromise = null;
  }

  return {
    doc: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedIds: [],
    selectedEdgeId: null,
    editingId: null,
    saveState: "saved",
    canUndo: false,
    canRedo: false,

    async load(canvasId) {
      await get().flush();
      const content = await backend.loadCanvas(canvasId);
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
        saveState: "saved",
        canUndo: false,
        canRedo: false,
      });
    },

    async flush() {
      if (saveTimer !== undefined) await save();
      else if (savingPromise) await savingPromise;
    },

    setViewport(viewport) {
      if (!get().doc) return;
      set({ viewport });
      // 视口只需要随下一次保存落盘，不单独计入编辑
      if (saveTimer === undefined && get().saveState === "saved") {
        saveTimer = window.setTimeout(() => void save(), SAVE_DELAY * 3);
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
      if (opts.select !== false) set({ selectedIds: elements.map((e) => e.id), selectedEdgeId: null });
      if (opts.edit && elements.length === 1) set({ editingId: elements[0].id });
    },

    updateElements(patches) {
      const now = Date.now();
      commit((s) => ({ ...s, elements: applyPatches(s.elements, patches, now) }));
    },

    deleteSelection() {
      const { selectedIds, selectedEdgeId } = get();
      if (selectedEdgeId) {
        commit((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selectedEdgeId) }));
        set({ selectedEdgeId: null });
        return;
      }
      if (selectedIds.length === 0) return;
      const gone = new Set(selectedIds);
      commit((s) => ({
        elements: s.elements.filter((e) => !gone.has(e.id)),
        edges: s.edges.filter((e) => !gone.has(e.fromId) && !gone.has(e.toId)),
      }));
      set({ selectedIds: [], editingId: null });
    },

    addEdge(fromId, toId) {
      if (fromId === toId) return;
      const exists = get().doc?.edges.some((e) => e.fromId === fromId && e.toId === toId);
      if (exists) return;
      const edge: Edge = { id: uuidv7(), fromId, toId };
      commit((s) => ({ ...s, edges: [...s.edges, edge] }));
      set({ selectedEdgeId: edge.id, selectedIds: [] });
    },

    groupSelection() {
      const { doc, selectedIds } = get();
      if (!doc || selectedIds.length === 0) return;
      const chosen = doc.elements.filter((e) => selectedIds.includes(e.id));
      const b = boundsOf(chosen);
      if (!b) return;
      const pad = 32;
      const now = Date.now();
      const section: SectionElement = {
        id: uuidv7(),
        type: "section",
        label: "新分组",
        x: b.x - pad,
        y: b.y - pad - 24,
        width: b.width + pad * 2,
        height: b.height + pad * 2 + 24,
        createdAt: now,
        updatedAt: now,
      };
      commit((s) => ({ ...s, elements: [section, ...s.elements] }));
      set({ selectedIds: [section.id], editingId: section.id });
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
      past = [...past, base].slice(-HISTORY_LIMIT);
      future = [];
      set({ canUndo: true, canRedo: false });
      scheduleSave();
    },

    undo() {
      const { doc } = get();
      const prev = past.at(-1);
      if (!doc || !prev) return;
      past = past.slice(0, -1);
      future = [snapshotOf(doc), ...future];
      set({ doc: { ...doc, ...prev }, canUndo: past.length > 0, canRedo: true, editingId: null });
      scheduleSave();
    },

    redo() {
      const { doc } = get();
      const next = future[0];
      if (!doc || !next) return;
      future = future.slice(1);
      past = [...past, snapshotOf(doc)];
      set({ doc: { ...doc, ...next }, canUndo: true, canRedo: future.length > 0, editingId: null });
      scheduleSave();
    },
  };
});

/** 退出前尽量把修改写盘 */
window.addEventListener("beforeunload", () => void useCanvasStore.getState().flush());
