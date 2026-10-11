import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftRight,
  BoxSelect,
  ClipboardPaste,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Link2,
  Map as MapIcon,
  Maximize,
  Minus,
  Paperclip,
  Plus,
  Redo2,
  StickyNote,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { canMoveInto, canvasAncestor, childCounts, isFolder, onCanvas, withAncestors } from "@/lib/folders";
import { boundsOf, contains, fitRect, intersects, normalizeRect, screenToWorld, zoomAt, type Point, type Rect } from "@/lib/geometry";
import { SNAP_PX, snapMove, snapResize, snapTargets, type Guide, type SnapTargets } from "@/lib/snap";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { elementMenu } from "@/features/menu/menus";
import { t, useT } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID, Viewport } from "@/types/model";
import { EdgeLayer } from "./EdgeLayer";
import { ElementView, type ElementHandlers } from "./ElementView";
import { folderRenameError, moveIntoFolderNamed, newFolderLabel, resolveIncoming } from "./cardNames";
import { copySelection, cutSelection, duplicateCards, pasteIntoCanvas } from "./clipboard";
import { FindBar, findMatches } from "./FindBar";
import { FolderPanel } from "./FolderPanel";
import { newMenuEntry } from "./newFiles";
import { openFromCanvas } from "./assetEditing";
import { importedMessage, pathsKey, runImport } from "./importing";
import { openLink, promptLink } from "./links";
import { Minimap } from "./Minimap";
import { assetsInTree, elementsForAssets, elementsForTree, newFolder, newTextCard } from "./placement";

type Gesture =
  | { kind: "pan"; start: Point; vp: Viewport }
  /** box：被拖动元素的整体外框（拖动前），吸附按它计算 */
  | {
      kind: "drag";
      start: Point;
      origins: Map<ID, Point>;
      box: Rect;
      moved: boolean;
      targets?: SnapTargets;
      /** 松手后要放进的文件夹 */
      dropFolderId?: ID;
    }
  | { kind: "marquee"; start: Point; base: ID[] }
  | { kind: "resize"; id: ID; start: Point; rect: Rect; ratio?: number; targets: SnapTargets }
  | { kind: "connect"; fromId: ID };

const NO_GUIDES: Guide[] = [];

/** 方向键微调：每次 1 像素，按住 Shift 10 像素 */
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** 缩放低于此值时卡片只画轮廓和首行文字 */
const LOD_ZOOM = 0.4;

/**
 * 渲染窗口：在视口四周各扩出半个视口。视口仍在窗口内时平移不触发 React 渲染，
 * 只直接改 DOM 的 transform；移出窗口、缩放跨过简化阈值或窗口远大于视口时才重新计算要渲染的元素。
 */
interface CullWindow {
  rect: Rect;
  lod: boolean;
}

function viewRect(vp: Viewport, w: number, h: number): Rect {
  return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, width: w / vp.zoom, height: h / vp.zoom };
}

function makeCull(vp: Viewport, w: number, h: number): CullWindow {
  const v = viewRect(vp, w, h);
  return {
    rect: { x: v.x - v.width / 2, y: v.y - v.height / 2, width: v.width * 2, height: v.height * 2 },
    lod: vp.zoom < LOD_ZOOM,
  };
}

function cullIsStale(c: CullWindow, vp: Viewport, w: number, h: number): boolean {
  const v = viewRect(vp, w, h);
  return (
    !contains(c.rect, v) || c.lod !== vp.zoom < LOD_ZOOM || c.rect.width * c.rect.height > v.width * v.height * 9
  );
}

const canvas = () => useCanvasStore.getState();
const app = () => useAppStore.getState();

/** 点了画布：文件夹窗口不再是当前操作的对象（此后 Ctrl+V 粘贴到画布上） */
function releasePanelFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".folder-panel")) active.blur();
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable='true']");

/** 命中测试：画布上点 p 处最上层的元素（后画的在上） */
function hitTest(elements: CanvasElement[], p: Point, exclude?: ReadonlySet<ID>): CanvasElement | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.parentId || exclude?.has(el.id)) continue;
    if (p.x >= el.x && p.x <= el.x + el.width && p.y >= el.y && p.y <= el.y + el.height) return el;
  }
  return undefined;
}

/** 画布上点 p 处的文件夹卡片 */
function folderAt(elements: CanvasElement[], p: Point, exclude?: ReadonlySet<ID>): ID | undefined {
  const hit = hitTest(elements, p, exclude);
  return hit && isFolder(hit) ? hit.id : undefined;
}

/** 屏幕坐标处的文件夹窗口：指着窗口里的子文件夹时是它，否则是窗口打开的文件夹 */
function panelFolderAt(clientX: number, clientY: number): ID | undefined {
  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const panel = hit?.closest<HTMLElement>(".folder-panel");
  if (!panel) return undefined;
  const sub = hit!.closest<HTMLElement>("[data-fp-folder], [data-fp-crumb]");
  return sub?.dataset.fpFolder ?? sub?.dataset.fpCrumb ?? canvas().folderView?.id;
}

interface Props {
  canvasId: ID;
  focusElementId?: ID;
  /** 搜索命中文件或图片时，定位到引用它的卡片 */
  focusAssetId?: ID;
  /** 从全局搜索跳过来时，打开画布内查找并填入这个词，命中的文字都高亮 */
  findQuery?: string;
}

export function CanvasView({ canvasId, focusElementId, focusAssetId, findQuery }: Props) {
  useT();
  const doc = useCanvasStore((s) => s.doc);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const editingId = useCanvasStore((s) => s.editingId);
  const assets = useAppStore((s) => s.assets);
  const minimapOpen = useAppStore((s) => s.minimapOpen);

  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [cull, setCull] = useState<CullWindow | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const spaceHeld = useRef(false);
  // 最近一次指针位置；粘贴时如果鼠标在画布上，就贴在鼠标处
  const lastPointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [pendingEdge, setPendingEdge] = useState<{ fromId: ID; to: Point } | null>(null);
  const [guides, setGuides] = useState<Guide[]>(NO_GUIDES);
  const [dropFolderId, setDropFolderId] = useState<ID | null>(null);
  const folderView = useCanvasStore((s) => s.folderView);
  // 按住方向键连续微调时合并成一步撤销，松开方向键时结束
  const nudging = useRef(false);
  const [panning, setPanning] = useState(false);
  const [highlightId, setHighlightId] = useState<ID | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // nav 每次跳转加一：即使跳到同一个结果也会重新定位
  const [find, setFind] = useState({ open: false, query: "", index: 0, nav: 0 });
  const highlightTimer = useRef<number | undefined>(undefined);
  // 从全局搜索跳过来的那张卡片：查找结果出来后，把查找栏的序号对到它
  const pendingFindFocus = useRef<ID | null>(null);

  const loaded = doc?.canvasId === canvasId;

  // ---- 加载与离开 ----
  useEffect(() => {
    canvas()
      .load(canvasId)
      .catch((e) => app().showToast(t("打开画布失败：{error}", { error: String(e) })));
    return () => void canvas().flush();
  }, [canvasId]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // 挂载后立即量一次尺寸，不等 ResizeObserver 的首次回调（页面在后台时它不会触发）
  useLayoutEffect(() => {
    const r = containerRef.current?.getBoundingClientRect();
    if (r && r.width > 0) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
  }, [loaded]);

  // 视口变化：直接写 DOM，必要时才更新渲染窗口（触发 React 渲染）
  useLayoutEffect(() => {
    if (!loaded || size.w === 0) return;
    const sync = (vp: Viewport) => {
      const world = worldRef.current;
      const root = containerRef.current;
      if (world) world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
      if (root) {
        root.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
        root.style.backgroundSize = `${24 * vp.zoom}px ${24 * vp.zoom}px`;
      }
      setCull((prev) => (prev && !cullIsStale(prev, vp, size.w, size.h) ? prev : makeCull(vp, size.w, size.h)));
    };
    sync(canvas().viewport);
    return useCanvasStore.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport) sync(s.viewport);
    });
  }, [loaded, size.w, size.h]);

  // 从搜索结果跳转过来时，把目标卡片移到视口中央并高亮
  useEffect(() => {
    if (!loaded || (!focusElementId && !focusAssetId) || size.w === 0) return;
    const elements = canvas().doc?.elements ?? [];
    const hits = elements.filter(
      (e) => e.id === focusElementId || (!!focusAssetId && "assetId" in e && e.assetId === focusAssetId),
    );
    // 同一个文件既在画布上又在文件夹里时，优先定位画布上的
    const el = hits.find(onCanvas) ?? hits[0];
    if (!el) return;
    // 在文件夹里的：定位到画布上包含它的文件夹，并打开它所在的文件夹窗口
    const shown = canvasAncestor(new Map(elements.map((e) => [e.id, e])), el.id);
    if (!shown) return;
    canvas().setViewport(fitRect(shown, size.w, size.h, 160, 1));
    canvas().select([shown.id]);
    setHighlightId(shown.id);
    if (el.parentId) canvas().openFolder(el.parentId, el.id);
    if (findQuery?.trim()) {
      // nav 不变：不再跳到第一处命中，停在搜索结果对应的卡片上；序号等结果算出来后再对齐
      setFind((f) => ({ ...f, open: true, query: findQuery.trim(), index: 0 }));
      pendingFindFocus.current = el.id;
    }
    const timer = window.setTimeout(() => setHighlightId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [loaded, focusElementId, focusAssetId, findQuery, size.w, size.h]);

  // ---- 坐标换算 ----
  const toLocal = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }) => screenToWorld(toLocal(e), canvas().viewport),
    [toLocal],
  );
  const viewCenterWorld = useCallback(() => screenToWorld({ x: size.w / 2, y: size.h / 2 }, canvas().viewport), [size]);
  const pasteAnchor = useCallback(() => {
    const p = lastPointer.current;
    const r = containerRef.current?.getBoundingClientRect();
    const inside = p && r && p.clientX >= r.left && p.clientX <= r.right && p.clientY >= r.top && p.clientY <= r.bottom;
    return inside ? toWorld(p) : viewCenterWorld();
  }, [toWorld, viewCenterWorld]);

  /** 吸附目标：视口里除 exclude 以外的元素 */
  const snapTargetsExcept = useCallback(
    (exclude: Set<ID>) => {
      const view = viewRect(canvas().viewport, size.w, size.h);
      return snapTargets(
        (canvas().doc?.elements ?? []).filter((el) => onCanvas(el) && !exclude.has(el.id) && intersects(view, el)),
      );
    },
    [size],
  );

  /** 粘贴的目标：文件夹窗口有焦点（点过窗口里面），或鼠标停在窗口上时，粘贴进窗口打开的文件夹；否则粘贴到画布上 */
  const pasteFolder = useCallback((): ID | undefined => {
    const open = canvas().folderView?.id;
    if (!open) return undefined;
    const p = lastPointer.current;
    const hovered = p && document.elementFromPoint(p.clientX, p.clientY)?.closest(".folder-panel");
    return hovered || document.activeElement?.closest(".folder-panel") ? open : undefined;
  }, []);

  const endNudge = useCallback(() => {
    if (!nudging.current) return;
    nudging.current = false;
    canvas().endGesture();
  }, []);

  /** 闪一下画布上的元素（文件夹里的不处理） */
  const flash = useCallback((id: ID) => {
    const el = canvas().doc?.elements.find((e) => e.id === id);
    if (!el || !onCanvas(el)) return;
    setHighlightId(id);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 1600);
  }, []);

  // ---- 导入文件 ----
  /** 导入文件放到画布上，左上角在 at；parentId 不为空时放进那个文件夹 */
  const placeAssets = useCallback(async (load: (task: string) => Promise<Asset[]>, at: Point, parentId?: ID) => {
    try {
      const imported = await runImport(load, { done: (a) => importedMessage(a.length) });
      if (!imported?.length) return;
      app().addAssets(imported);
      // 与这一层已有的文件、文件夹重名时要求改名
      const cards = await resolveIncoming(
        elementsForAssets(imported, at).map((el) => (parentId ? { ...el, parentId } : el)),
        parentId,
        "ask",
      );
      canvas().addElements(cards, { select: !parentId });
      if (parentId) {
        flash(parentId);
        canvas().showInOpenFolder(parentId, cards.map((c) => c.id));
      }
    } catch (e) {
      app().showToast(t("导入失败：{error}", { error: String(e) }));
    }
  }, []);

  /** 按路径导入文件和文件夹：文件夹变成文件夹卡片，里面的内容放进去；parentId 不为空时全部放进那个文件夹 */
  const placeTree = useCallback(async (paths: string[], at: Point, parentId?: ID) => {
    try {
      const nodes = await runImport((task) => backend.importTree(paths, task), {
        key: pathsKey(paths),
        done: (n) => importedMessage(assetsInTree(n).length),
      });
      if (!nodes) return;
      const assets = assetsInTree(nodes);
      if (assets.length === 0 && nodes.length === 0) return;
      app().addAssets(assets);
      const added = await resolveIncoming(elementsForTree(nodes, at, parentId), parentId, "ask");
      canvas().addElements(added, { select: !parentId });
      if (parentId) {
        flash(parentId);
        canvas().showInOpenFolder(parentId, added.filter((el) => el.parentId === parentId).map((el) => el.id));
      }
    } catch (e) {
      app().showToast(t("导入失败：{error}", { error: String(e) }));
    }
  }, []);

  /** 选择文件（或文件夹）放到画布上；不指定位置时放在视口中央；parentId 不为空时放进那个文件夹 */
  const pickFiles = useCallback(async (where?: Point, folders = false, parentId?: ID) => {
    if (!canvas().doc) return;
    const at = where ?? viewCenterWorld();
    if (backend.kind === "tauri") {
      const picked = await open({
        multiple: true,
        directory: folders,
        title: folders ? t("选择要放到画布上的文件夹") : t("选择要放到画布上的文件"),
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) await placeTree(paths, at, parentId);
    } else if (folders) {
      app().showToast(t("浏览器预览模式不支持按路径导入"));
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        if (files.length) void placeAssets((task) => backend.importBlobs(files, task), at, parentId);
      };
      input.click();
    }
  }, [placeAssets, placeTree, viewCenterWorld]);

  // ---- 文件夹窗口用到的坐标换算 ----
  /** 屏幕坐标处是否是画布上可以放东西的地方（不在工具栏、小地图、查找栏、文件夹窗口上） */
  const canvasPointAt = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const root = containerRef.current;
      const hit = document.elementFromPoint(clientX, clientY);
      if (!root || !hit || !root.contains(hit) || hit.closest(".canvas-toolbar, .minimap, .find-bar, .folder-panel")) return null;
      return toWorld({ clientX, clientY });
    },
    [toWorld],
  );
  const canvasFolderAt = useCallback(
    (clientX: number, clientY: number) => folderAt(canvas().doc?.elements ?? [], toWorld({ clientX, clientY })) ?? null,
    [toWorld],
  );

  // 桌面端：系统文件拖放由 Tauri 接管，拿到的是绝对路径
  useEffect(() => {
    if (backend.kind !== "tauri") return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over" || p.type === "enter") setDropActive(true);
        else if (p.type === "leave") setDropActive(false);
        else if (p.type === "drop") {
          setDropActive(false);
          if (!canvas().doc || p.paths.length === 0) return;
          const ratio = window.devicePixelRatio || 1;
          const client = { clientX: p.position.x / ratio, clientY: p.position.y / ratio };
          const at = toWorld(client);
          // 拖到文件夹窗口或画布上的文件夹卡片上：导入到那个文件夹里
          const into = panelFolderAt(client.clientX, client.clientY) ?? folderAt(canvas().doc!.elements, at);
          void placeTree(p.paths, at, into);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [placeTree, toWorld]);

  // ---- 视口操作 ----
  const fitAll = useCallback(() => {
    const b = boundsOf((canvas().doc?.elements ?? []).filter(onCanvas));
    if (b) canvas().setViewport(fitRect(b, size.w, size.h));
  }, [size]);

  const zoomBy = useCallback(
    (factor: number) => {
      const vp = canvas().viewport;
      canvas().setViewport(zoomAt(vp, { x: size.w / 2, y: size.h / 2 }, vp.zoom * factor));
    },
    [size],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      // 文件夹窗口里的滚动留给窗口自己
      if (isTyping(e.target) || !canvas().doc || (e.target as HTMLElement).closest?.(".folder-panel")) return;
      const vp = canvas().viewport;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        canvas().setViewport(zoomAt(vp, toLocal(e), vp.zoom * Math.exp(-e.deltaY * unit * 0.0015)));
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        canvas().setViewport({ ...vp, x: vp.x - dx * unit, y: vp.y - dy * unit });
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [toLocal]);

  // ---- 键盘与剪贴板 ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F 换成画布内查找：浏览器自带的网页查找看不到视口外的卡片和图片中的文字
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (app().searchOpen || !canvas().doc) return;
        e.preventDefault();
        setFind((f) => ({ ...f, open: true }));
        const input = document.querySelector<HTMLInputElement>("[data-find-input]");
        input?.focus();
        input?.select();
        return;
      }
      if (app().searchOpen || isTyping(e.target) || !canvas().doc) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const s = canvas();
      const nudge = NUDGE[e.key];
      if (nudge && !mod && !e.altKey) {
        if (s.selectedIds.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (!nudging.current) {
          s.beginGesture();
          nudging.current = true;
        }
        const moving = new Set(s.selectedIds);
        const patches: Record<ID, Point> = {};
        for (const el of s.doc!.elements) {
          if (moving.has(el.id)) patches[el.id] = { x: el.x + nudge[0] * step, y: el.y + nudge[1] * step };
        }
        s.updateDuringGesture(patches);
        return;
      }
      // 微调中按了别的键（如 Ctrl+Z）：先把微调记入历史
      endNudge();
      if (e.code === "Space") {
        e.preventDefault();
        spaceHeld.current = true;
      } else if (key === "delete" || key === "backspace") {
        s.deleteSelection();
      } else if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        s.redo();
      } else if (mod && key === "g") {
        e.preventDefault();
        s.groupSelection();
      } else if (mod && key === "a") {
        e.preventDefault();
        s.select(s.doc!.elements.filter(onCanvas).map((el) => el.id));
      } else if (mod && (key === "=" || key === "+")) {
        e.preventDefault();
        zoomBy(1.25);
      } else if (mod && key === "-") {
        e.preventDefault();
        zoomBy(0.8);
      } else if (mod && key === "0") {
        e.preventDefault();
        zoomBy(1 / s.viewport.zoom);
      } else if (e.shiftKey && e.code === "Digit1") {
        fitAll();
      } else if (key === "escape") {
        if (s.selectedIds.length === 0 && s.folderView) s.openFolder(null);
        else s.select([]);
      } else if (key === "f2" && s.selectedIds.length === 1) {
        const el = s.doc!.elements.find((x) => x.id === s.selectedIds[0]);
        if (el?.type === "folder") {
          e.preventDefault();
          s.setEditing(el.id);
        }
      } else if (key === "enter" && s.selectedIds.length === 1) {
        const el = s.doc!.elements.find((x) => x.id === s.selectedIds[0]);
        if (el?.type === "text") {
          e.preventDefault();
          s.openEditor(el.id);
        } else if (el?.type === "folder") {
          e.preventDefault();
          s.openFolder(el.id);
        } else if (el?.type === "link") {
          e.preventDefault();
          void openLink(el.url);
        }
      } else if (mod && (key === "c" || key === "x") && s.selectedIds.length > 0) {
        // 页面里有选中的文字（如检查器中的识别结果）时，保留浏览器的复制文字
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        void (key === "x" ? cutSelection() : copySelection());
      } else if (mod && key === "d") {
        e.preventDefault();
        void duplicateCards(s.selectedIds);
      } else if (key === "t" && !mod) {
        s.addElements([newTextCard(viewCenterWorld())], { edit: true });
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
      if (NUDGE[e.key]) endNudge();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (app().searchOpen || isTyping(e.target) || !canvas().doc) return;
      e.preventDefault();
      // 浏览器提供的剪贴板数据只能在事件内同步读取，先取出来作为后备
      const fallback = {
        files: Array.from(e.clipboardData?.files ?? []),
        text: e.clipboardData?.getData("text/plain") ?? "",
      };
      const folder = pasteFolder();
      void pasteIntoCanvas(pasteAnchor(), fallback, folder).then((ids) => {
        // 在窗口里选中粘贴进来的
        if (folder && ids.length) canvas().openFolder(folder, ids);
      });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    // 按住方向键时切走窗口，收不到 keyup
    window.addEventListener("blur", endNudge);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("blur", endNudge);
      endNudge();
    };
  }, [fitAll, zoomBy, viewCenterWorld, pasteAnchor, pasteFolder, endNudge]);

  // ---- 指针手势 ----
  const capture = (e: ReactPointerEvent) => {
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // 指针已释放（例如合成事件），忽略
    }
  };

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (!canvas().doc) return;
    endNudge();
    releasePanelFocus();
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault();
      gesture.current = { kind: "pan", start: toLocal(e), vp: canvas().viewport };
      setPanning(true);
    } else if (e.button === 0) {
      const base = e.shiftKey ? canvas().selectedIds : [];
      if (!e.shiftKey) canvas().select([]);
      gesture.current = { kind: "marquee", start: toWorld(e), base };
    } else {
      return;
    }
    capture(e);
  };

  const handlersRef = useRef<ElementHandlers>(null!);
  handlersRef.current = {
    onPointerDown(e, id) {
      if (e.button !== 0 || spaceHeld.current) return; // 交给背景处理平移
      e.stopPropagation();
      endNudge();
      releasePanelFocus();
      const s = canvas();
      if (!s.doc || s.editingId === id) return;
      if (e.shiftKey) {
        s.select([id], true);
        return;
      }
      let ids = s.selectedIds;
      if (!ids.includes(id)) {
        s.select([id]);
        ids = [id];
      }
      const moving = new Set(ids);
      const origins = new Map<ID, Point>();
      const movingEls = s.doc.elements.filter((el) => moving.has(el.id) && onCanvas(el));
      for (const el of movingEls) origins.set(el.id, { x: el.x, y: el.y });
      // 真正拖动后才捕获指针：过早捕获会让双击事件落到画布背景上
      gesture.current = { kind: "drag", start: toWorld(e), origins, box: boundsOf(movingEls)!, moved: false };
    },
    onResizeStart(e, id) {
      e.stopPropagation();
      endNudge();
      const el = canvas().doc?.elements.find((x) => x.id === id);
      if (!el) return;
      const ratio = el.type === "image" ? el.height / el.width : undefined;
      const rect = { x: el.x, y: el.y, width: el.width, height: el.height };
      gesture.current = { kind: "resize", id, start: toWorld(e), rect, ratio, targets: snapTargetsExcept(new Set([id])) };
      canvas().beginGesture();
      capture(e);
    },
    onConnectStart(e, id) {
      e.stopPropagation();
      gesture.current = { kind: "connect", fromId: id };
      setPendingEdge({ fromId: id, to: toWorld(e) });
      capture(e);
    },
    onDoubleClick(id) {
      const el = canvas().doc?.elements.find((x) => x.id === id);
      if (!el) return;
      if (el.type === "text") canvas().openEditor(id);
      else if (el.type === "folder") canvas().openFolder(id);
      else if (el.type === "link") void openLink(el.url);
      else {
        const asset = app().assets.get(el.assetId);
        if (!asset) app().showToast(t("找不到这个文件"));
        else void openFromCanvas(asset, id);
      }
    },
    onContextMenu(e, id) {
      // 右键未选中的卡片时，先单独选中它
      if (!canvas().selectedIds.includes(id)) canvas().select([id]);
      openContextMenu(e, elementMenu(canvas().selectedIds));
    },
    onFinishEdit(id, value) {
      const s = canvas();
      const el = s.doc?.elements.find((x) => x.id === id);
      s.setEditing(null);
      if (!el) return;
      if (el.type === "text") {
        if (!value.trim() && !el.text.trim()) {
          s.select([id]);
          s.deleteSelection();
        } else if (value !== el.text) {
          s.updateElements({ [id]: { text: value } });
        }
      } else if (el.type === "folder" && value !== el.label) {
        // 同一层里已有这个名字：保留原来的名字
        const error = folderRenameError(el, value);
        if (error) app().showToast(error);
        else s.updateElements({ [id]: { label: value } });
      }
    },
  };
  const handlers = useMemo<ElementHandlers>(
    () => ({
      onPointerDown: (e, id) => handlersRef.current.onPointerDown(e, id),
      onResizeStart: (e, id) => handlersRef.current.onResizeStart(e, id),
      onConnectStart: (e, id) => handlersRef.current.onConnectStart(e, id),
      onDoubleClick: (id) => handlersRef.current.onDoubleClick(id),
      onFinishEdit: (id, v) => handlersRef.current.onFinishEdit(id, v),
      onContextMenu: (e, id) => handlersRef.current.onContextMenu(e, id),
    }),
    [],
  );

  const onPointerMove = (e: ReactPointerEvent) => {
    lastPointer.current = { clientX: e.clientX, clientY: e.clientY };
    const g = gesture.current;
    const s = canvas();
    if (!g || !s.doc) return;
    switch (g.kind) {
      case "pan": {
        const p = toLocal(e);
        s.setViewport({ ...g.vp, x: g.vp.x + p.x - g.start.x, y: g.vp.y + p.y - g.start.y });
        break;
      }
      case "drag": {
        const w = toWorld(e);
        const dx = w.x - g.start.x;
        const dy = w.y - g.start.y;
        if (!g.moved) {
          if (Math.hypot(dx, dy) * s.viewport.zoom < 3) return;
          g.moved = true;
          g.targets = snapTargetsExcept(new Set(g.origins.keys()));
          s.beginGesture();
          capture(e);
        }
        // 按住 Alt 时不吸附
        let sx = 0;
        let sy = 0;
        if (g.targets && !e.altKey) {
          const snap = snapMove({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.targets, SNAP_PX / s.viewport.zoom);
          sx = snap.dx;
          sy = snap.dy;
          setGuides(snap.guides.length ? snap.guides : NO_GUIDES);
        } else {
          setGuides(NO_GUIDES);
        }
        const patches: Record<ID, Point> = {};
        for (const [id, o] of g.origins) patches[id] = { x: o.x + dx + sx, y: o.y + dy + sy };
        s.updateDuringGesture(patches);
        // 指针移到文件夹卡片或文件夹窗口上：高亮它，松手时放进去。按住 Alt 时不放进文件夹
        const moving = new Set(g.origins.keys());
        let into = e.altKey ? undefined : (panelFolderAt(e.clientX, e.clientY) ?? folderAt(s.doc.elements, w, moving));
        if (into && !canMoveInto(s.doc.elements, moving, into)) into = undefined;
        g.dropFolderId = into;
        setDropFolderId(into ?? null);
        break;
      }
      case "marquee": {
        const r = normalizeRect(g.start, toWorld(e));
        setMarquee(r);
        const hit = s.doc.elements.filter((el) => onCanvas(el) && intersects(r, el)).map((el) => el.id);
        s.select([...new Set([...g.base, ...hit])]);
        break;
      }
      case "resize": {
        const w = toWorld(e);
        let width = Math.max(80, g.rect.width + w.x - g.start.x);
        let height = g.ratio ? width * g.ratio : Math.max(48, g.rect.height + w.y - g.start.y);
        if (!e.altKey) {
          const snap = snapResize({ ...g.rect, width, height }, g.targets, SNAP_PX / s.viewport.zoom, !!g.ratio);
          if (snap.width >= 80 && snap.height >= 48) ({ width, height } = snap);
          setGuides(snap.guides.length ? snap.guides : NO_GUIDES);
        } else {
          setGuides(NO_GUIDES);
        }
        s.updateDuringGesture({ [g.id]: { width, height } });
        break;
      }
      case "connect":
        setPendingEdge({ fromId: g.fromId, to: toWorld(e) });
        break;
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    const s = canvas();
    if (!g || !s.doc) return;
    setGuides(NO_GUIDES);
    setDropFolderId(null);
    if (g.kind === "drag" && g.moved) {
      const into = g.dropFolderId;
      if (into) {
        // 卡片先回到原位再放进文件夹，撤销时一步回到拖动前
        s.cancelGesture();
        void moveIntoFolderNamed([...g.origins.keys()], into).then((moved) => moved && flash(into));
      } else {
        s.endGesture();
      }
    }
    else if (g.kind === "resize") s.endGesture();
    else if (g.kind === "marquee") setMarquee(null);
    else if (g.kind === "pan") setPanning(false);
    else if (g.kind === "connect") {
      setPendingEdge(null);
      const target = hitTest(s.doc.elements, toWorld(e), new Set([g.fromId]));
      if (target) s.addEdge(g.fromId, target.id);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!canvas().doc || (e.target as HTMLElement).closest("[data-element-id], .canvas-toolbar, .minimap, .folder-panel")) return;
    canvas().addElements([newTextCard(toWorld(e))], { edit: true });
  };

  // ---- 右键菜单：画布空白处与连线 ----
  const onBackgroundMenu = (e: ReactMouseEvent) => {
    if (!canvas().doc || (e.target as HTMLElement).closest("[data-element-id], .canvas-toolbar, .minimap, .find-bar, .folder-panel"))
      return;
    const at = toWorld(e);
    canvas().select([]);
    openContextMenu(e, [
      // 新建的卡片、文件夹、链接和文件都在这里，与 Windows 右键菜单「新建」对应
      newMenuEntry({
        at,
        textHint: t("双击"),
        text: () => canvas().addElements([newTextCard(at)], { edit: true }),
        folder: () => canvas().addElements([newFolder(at, undefined, newFolderLabel())], { edit: true }),
        link: () => void promptLink(at),
      }),
      "separator",
      { label: t("在此插入文件…"), icon: <Paperclip size={15} />, onSelect: () => void pickFiles(at) },
      { label: t("从电脑导入文件夹…"), icon: <FolderOpen size={15} />, onSelect: () => void pickFiles(at, true) },
      {
        label: t("粘贴"),
        icon: <ClipboardPaste size={15} />,
        hint: "Ctrl+V",
        onSelect: () => void pasteIntoCanvas(at, { files: [], text: "" }),
      },
      "separator",
      {
        label: t("全选"),
        icon: <BoxSelect size={15} />,
        hint: "Ctrl+A",
        onSelect: () => canvas().select(canvas().doc!.elements.filter(onCanvas).map((el) => el.id)),
      },
      { label: t("显示全部内容"), icon: <Maximize size={15} />, hint: "Shift+1", onSelect: fitAll },
      {
        label: app().minimapOpen ? t("隐藏小地图") : t("显示小地图"),
        icon: <MapIcon size={15} />,
        onSelect: () => app().toggleMinimap(),
      },
    ]);
  };

  const onEdgeMenu = useCallback((e: ReactMouseEvent, id: ID) => {
    canvas().selectEdge(id);
    openContextMenu(e, [
      { label: t("反转方向"), icon: <ArrowLeftRight size={15} />, onSelect: () => canvas().reverseEdge(id) },
      "separator",
      {
        label: t("删除连线"),
        icon: <Trash2 size={15} />,
        hint: "Delete",
        danger: true,
        onSelect: () => {
          canvas().selectEdge(id);
          canvas().deleteSelection();
        },
      },
    ]);
  }, []);
  const onEdgeSelect = useCallback((id: ID) => canvas().selectEdge(id), []);

  // 其他组件（如检查器的文件列表）请求定位某个元素
  const focusRequest = useCanvasStore((s) => s.focusRequest);
  useEffect(() => {
    if (focusRequest) revealElement(focusRequest.id, focusRequest.select);
  }, [focusRequest]);

  // 浏览器预览模式下的 HTML5 拖放
  const browserDrop =
    backend.kind === "browser"
      ? {
          onDragOver: (e: ReactDragEvent) => {
            e.preventDefault();
            setDropActive(true);
          },
          onDragLeave: () => setDropActive(false),
          onDrop: (e: ReactDragEvent) => {
            e.preventDefault();
            setDropActive(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) void placeAssets((task) => backend.importBlobs(files, task), toWorld(e));
          },
        }
      : {};

  // ---- 渲染：只画视口附近的元素 ----
  // ---- 画布内查找 ----
  const elements = doc?.elements;
  const matches = useMemo(
    () => (elements && find.open ? findMatches(elements, assets, find.query) : []),
    [elements, assets, find.open, find.query],
  );

  /** 把元素移到视口中央（缩得太小时放大到 100%），选中并闪一下；在文件夹里的，定位到文件夹并打开它所在的文件夹窗口 */
  const revealElement = useCallback(
    (id: ID, select = true) => {
      const all = canvas().doc?.elements ?? [];
      const target = all.find((e) => e.id === id);
      if (!target || size.w === 0) return;
      const el = target.parentId ? canvasAncestor(new Map(all.map((e) => [e.id, e])), id) : target;
      if (!el) return;
      const vp = canvas().viewport;
      const zoom = vp.zoom < 0.5 ? 1 : vp.zoom;
      canvas().setViewport({
        zoom,
        x: size.w / 2 - (el.x + el.width / 2) * zoom,
        y: size.h / 2 - (el.y + el.height / 2) * zoom,
      });
      if (select) canvas().select([el.id]);
      flash(el.id);
      if (target.parentId) canvas().openFolder(target.parentId, target.id);
    },
    [size, flash],
  );

  // 输入查询或按上一个 / 下一个时定位；编辑画布导致结果变化时不跳，以免打断用户
  useEffect(() => {
    const id = pendingFindFocus.current;
    if (!id || !find.open) return;
    pendingFindFocus.current = null;
    const i = matches.indexOf(id);
    if (i > 0) setFind((f) => ({ ...f, index: i }));
  }, [matches, find.open]);

  const currentMatch = matches.length ? matches[Math.min(find.index, matches.length - 1)] : undefined;
  useEffect(() => {
    if (find.open && currentMatch) revealElement(currentMatch);
  }, [find.nav]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  // 命中的元素和包含它们的各层文件夹：画布上的文件夹卡片、窗口里的子文件夹据此标出「里面有命中」
  const matchPath = useMemo(() => withAncestors(elements ?? [], matches), [elements, matches]);
  const currentPath = useMemo(
    () => withAncestors(elements ?? [], find.open && currentMatch ? [currentMatch] : []),
    [elements, find.open, currentMatch],
  );
  // 文件夹里的内容不画在画布上
  const shown = useMemo(() => elements?.filter(onCanvas) ?? [], [elements]);
  const counts = useMemo(() => childCounts(elements ?? []), [elements]);
  const visible = useMemo(() => {
    if (!cull) return [];
    return shown.filter((el) => intersects(cull.rect, el) || selectedSet.has(el.id) || el.id === editingId);
  }, [shown, cull, selectedSet, editingId]);

  if (!doc || !loaded) return <div className="canvas-root is-loading" ref={containerRef} />;

  const lod = cull?.lod ?? false;
  const single = selectedIds.length === 1 ? selectedIds[0] : null;
  const renderEl = (el: CanvasElement) => {
    const asset = el.type === "image" || el.type === "file" ? assets.get(el.assetId) : undefined;
    return (
      <ElementView
        key={el.id}
        el={el}
        selected={selectedSet.has(el.id)}
        showHandles={single === el.id && !lod}
        editing={editingId === el.id}
        highlighted={highlightId === el.id}
        matched={matchPath.has(el.id)}
        findQuery={matchSet.has(el.id) ? find.query : undefined}
        currentMatch={currentPath.has(el.id)}
        dropTarget={dropFolderId === el.id}
        itemCount={el.type === "folder" ? (counts.get(el.id) ?? 0) : undefined}
        lod={lod}
        asset={asset}
        assetUrl={asset && el.type === "image" ? backend.assetUrl(asset) : undefined}
        handlers={handlers}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      className={`canvas-root${panning ? " is-panning" : ""}${dropActive ? " is-drop-target" : ""}`}
      onPointerDown={onBackgroundPointerDown}
      // 按下时也记一次位置：决定粘贴到画布还是文件夹窗口时不依赖之前有没有移动过鼠标
      onPointerDownCapture={(e) => (lastPointer.current = { clientX: e.clientX, clientY: e.clientY })}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onBackgroundMenu}
      {...browserDrop}
    >
      {/* transform 由上面的视口订阅直接写入，不经过 React */}
      <div className="canvas-world" ref={worldRef}>
        <EdgeLayer
          edges={doc.edges}
          elements={doc.elements}
          selectedEdgeId={selectedEdgeId}
          pending={pendingEdge}
          onSelect={onEdgeSelect}
          onContextMenu={onEdgeMenu}
        />
        {visible.map(renderEl)}
        {guides.map((g, i) => {
          // 参考线始终 1 个屏幕像素粗
          const px = 1 / canvas().viewport.zoom;
          const vertical = g.axis === "x";
          return (
            <div
              key={i}
              className="snap-guide"
              style={{
                transform: vertical ? `translate(${g.at - px / 2}px, ${g.from}px)` : `translate(${g.from}px, ${g.at - px / 2}px)`,
                width: vertical ? px : g.to - g.from,
                height: vertical ? g.to - g.from : px,
              }}
            />
          );
        })}
        {marquee && (
          <div
            className="marquee"
            style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.width, height: marquee.height }}
          />
        )}
      </div>

      {shown.length === 0 && (
        <div className="canvas-empty">
          <p>{t("双击空白处新建卡片")}</p>
          <p>{t("或把文件、图片拖进来")}</p>
        </div>
      )}

      {minimapOpen && <Minimap elements={shown} screen={size} />}

      {folderView && (
        <FolderPanel
          folderId={folderView.id}
          focusIds={folderView.focusIds}
          focusN={folderView.n}
          dropTarget={dropFolderId}
          find={find.open && find.query.trim() ? { query: find.query, matches: matchSet, paths: matchPath, current: currentPath } : null}
          canvasPointAt={canvasPointAt}
          canvasFolderAt={canvasFolderAt}
          setCanvasDrop={setDropFolderId}
          viewCenter={viewCenterWorld}
          insertFiles={(folders) => void pickFiles(viewCenterWorld(), folders, folderView.id)}
        />
      )}

      {find.open && (
        <FindBar
          query={find.query}
          index={Math.min(find.index, Math.max(matches.length - 1, 0))}
          total={matches.length}
          onQuery={(query) => setFind((f) => ({ ...f, query, index: 0, nav: f.nav + 1 }))}
          onStep={(delta) => {
            const n = matches.length;
            if (n === 0) return;
            setFind((f) => ({ ...f, index: (Math.min(f.index, n - 1) + delta + n) % n, nav: f.nav + 1 }));
          }}
          onClose={() => setFind((f) => ({ ...f, open: false }))}
        />
      )}

      <Toolbar
        minimapOpen={minimapOpen}
        onAddText={() => canvas().addElements([newTextCard(viewCenterWorld())], { edit: true })}
        onAddFiles={() => void pickFiles()}
        onAddLink={() => void promptLink(viewCenterWorld())}
        onAddFolder={() => void pickFiles(undefined, true)}
        onNewFolder={() => canvas().addElements([newFolder(viewCenterWorld(), undefined, newFolderLabel())], { edit: true })}
        onGroup={() => canvas().groupSelection()}
        onZoom={zoomBy}
        onFit={fitAll}
      />
    </div>
  );
}

function Toolbar(props: {
  minimapOpen: boolean;
  onAddText(): void;
  onAddFiles(): void;
  onAddLink(): void;
  onAddFolder(): void;
  onNewFolder(): void;
  onGroup(): void;
  onZoom(factor: number): void;
  onFit(): void;
}) {
  useT();
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const hasSelection = useCanvasStore((s) => s.selectedIds.length > 0);
  // 只订阅百分比，平移时工具栏不会重新渲染
  const zoomPercent = useCanvasStore((s) => Math.round(s.viewport.zoom * 100));
  const stop = (e: ReactPointerEvent) => e.stopPropagation();
  return (
    <div className="canvas-toolbar" onPointerDown={stop} onDoubleClick={(e) => e.stopPropagation()}>
      <button className="tb-btn" onClick={props.onAddText} title={t("新建文本卡片（T）")}>
        <StickyNote size={16} />
        <span>{t("文本")}</span>
      </button>
      <button className="tb-btn" onClick={props.onAddFiles} title={t("插入文件或图片")}>
        <Paperclip size={16} />
        <span>{t("文件")}</span>
      </button>
      <button className="tb-btn" onClick={props.onAddLink} title={t("添加网页链接（也可以直接粘贴网址）")}>
        <Link2 size={16} />
        <span>{t("链接")}</span>
      </button>
      <button
        className="tb-btn"
        title={t("文件夹：新建、放入选中的卡片，或从电脑导入")}
        onClick={(e) =>
          openContextMenu(e, [
            {
              label: t("把选中的卡片放进文件夹"),
              icon: <FolderInput size={15} />,
              hint: "Ctrl+G",
              disabled: !hasSelection,
              onSelect: props.onGroup,
            },
            { label: t("新建空文件夹"), icon: <FolderPlus size={15} />, onSelect: props.onNewFolder },
            "separator",
            { label: t("从电脑导入文件夹…"), icon: <FolderOpen size={15} />, onSelect: props.onAddFolder },
          ])
        }
      >
        <Folder size={16} />
        <span>{t("文件夹")}</span>
      </button>
      <span className="tb-sep" />
      <button className="tb-icon" onClick={() => canvas().undo()} disabled={!canUndo} title={t("撤销（Ctrl+Z）")}>
        <Undo2 size={16} />
      </button>
      <button className="tb-icon" onClick={() => canvas().redo()} disabled={!canRedo} title={t("重做（Ctrl+Shift+Z）")}>
        <Redo2 size={16} />
      </button>
      <span className="tb-sep" />
      <button className="tb-icon" onClick={() => props.onZoom(0.8)} title={t("缩小（Ctrl+-）")}>
        <Minus size={16} />
      </button>
      <button className="tb-zoom" onClick={() => props.onZoom(100 / zoomPercent)} title={t("恢复 100%（Ctrl+0）")}>
        {zoomPercent}%
      </button>
      <button className="tb-icon" onClick={() => props.onZoom(1.25)} title={t("放大（Ctrl+=）")}>
        <Plus size={16} />
      </button>
      <button className="tb-icon" onClick={props.onFit} title={t("显示全部内容（Shift+1）")}>
        <Maximize size={16} />
      </button>
      <button
        className={`tb-icon${props.minimapOpen ? " is-on" : ""}`}
        onClick={() => useAppStore.getState().toggleMinimap()}
        title={t("显示 / 隐藏小地图")}
      >
        <MapIcon size={16} />
      </button>
    </div>
  );
}
