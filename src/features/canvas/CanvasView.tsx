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
import {
  boundsOf,
  contains,
  fitRect,
  intersects,
  normalizeRect,
  screenToWorld,
  zoomAt,
  type Point,
  type Rect,
} from "@/lib/geometry";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { elementMenu } from "@/features/menu/menus";
import { t, useT } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID, Viewport } from "@/types/model";
import { EdgeLayer } from "./EdgeLayer";
import { ElementView, type ElementHandlers } from "./ElementView";
import { copySelection, pasteIntoCanvas } from "./clipboard";
import { FindBar, findMatches } from "./FindBar";
import { Minimap } from "./Minimap";
import { assetsInTree, elementsForAssets, elementsForTree, newFolder, newTextCard } from "./placement";

type Gesture =
  | { kind: "pan"; start: Point; vp: Viewport }
  | { kind: "drag"; start: Point; origins: Map<ID, Point>; moved: boolean }
  | { kind: "marquee"; start: Point; base: ID[] }
  | { kind: "resize"; id: ID; start: Point; width: number; height: number; ratio?: number }
  | { kind: "connect"; fromId: ID };

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

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable='true']");

/** 命中测试：先找普通卡片（后画的在上），再找分组框 */
function hitTest(elements: CanvasElement[], p: Point, exclude?: ID): CanvasElement | undefined {
  const inside = (el: CanvasElement) =>
    el.id !== exclude && p.x >= el.x && p.x <= el.x + el.width && p.y >= el.y && p.y <= el.y + el.height;
  const cards = elements.filter((e) => e.type !== "section");
  for (let i = cards.length - 1; i >= 0; i--) if (inside(cards[i])) return cards[i];
  return elements.find((e) => e.type === "section" && inside(e));
}

interface Props {
  canvasId: ID;
  focusElementId?: ID;
  /** 搜索命中文件或图片时，定位到引用它的卡片 */
  focusAssetId?: ID;
}

export function CanvasView({ canvasId, focusElementId, focusAssetId }: Props) {
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
  const [panning, setPanning] = useState(false);
  const [highlightId, setHighlightId] = useState<ID | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // nav 每次跳转加一：即使跳到同一个结果也会重新定位
  const [find, setFind] = useState({ open: false, query: "", index: 0, nav: 0 });
  const highlightTimer = useRef<number | undefined>(undefined);

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
    const el = canvas().doc?.elements.find(
      (e) => e.id === focusElementId || (!!focusAssetId && "assetId" in e && e.assetId === focusAssetId),
    );
    if (!el) return;
    canvas().setViewport(fitRect(el, size.w, size.h, 160, 1));
    canvas().select([el.id]);
    setHighlightId(el.id);
    const timer = window.setTimeout(() => setHighlightId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [loaded, focusElementId, focusAssetId, size.w, size.h]);

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

  // ---- 导入文件 ----
  const placeAssets = useCallback(async (load: () => Promise<Asset[]>, at: Point) => {
    try {
      const imported = await load();
      if (imported.length === 0) return;
      app().addAssets(imported);
      canvas().addElements(elementsForAssets(imported, at));
    } catch (e) {
      app().showToast(t("导入失败：{error}", { error: String(e) }));
    }
  }, []);

  /** 按路径导入文件和文件夹：文件夹变成分组框，里面的文件按网格排好 */
  const placeTree = useCallback(async (paths: string[], at: Point) => {
    try {
      const nodes = await backend.importTree(paths);
      const assets = assetsInTree(nodes);
      if (assets.length === 0 && nodes.length === 0) return;
      app().addAssets(assets);
      canvas().addElements(elementsForTree(nodes, at));
    } catch (e) {
      app().showToast(t("导入失败：{error}", { error: String(e) }));
    }
  }, []);

  /** 选择文件（或文件夹）放到画布上；不指定位置时放在视口中央 */
  const pickFiles = useCallback(async (where?: Point, folders = false) => {
    if (!canvas().doc) return;
    const at = where ?? viewCenterWorld();
    if (backend.kind === "tauri") {
      const picked = await open({
        multiple: true,
        directory: folders,
        title: folders ? t("选择要放到画布上的文件夹") : t("选择要放到画布上的文件"),
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) await placeTree(paths, at);
    } else if (folders) {
      app().showToast(t("浏览器预览模式不支持按路径导入"));
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        if (files.length) void placeAssets(() => backend.importBlobs(files), at);
      };
      input.click();
    }
  }, [placeAssets, placeTree, viewCenterWorld]);

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
          const at = toWorld({ clientX: p.position.x / ratio, clientY: p.position.y / ratio });
          void placeTree(p.paths, at);
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
    const b = boundsOf(canvas().doc?.elements ?? []);
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
      if (isTyping(e.target) || !canvas().doc) return;
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
        s.select(s.doc!.elements.map((el) => el.id));
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
        s.select([]);
      } else if (key === "enter" && s.selectedIds.length === 1) {
        const el = s.doc!.elements.find((x) => x.id === s.selectedIds[0]);
        if (el?.type === "text") {
          e.preventDefault();
          s.openEditor(el.id);
        } else if (el?.type === "section") {
          e.preventDefault();
          s.setEditing(el.id);
        }
      } else if (mod && key === "c" && s.selectedIds.length > 0) {
        // 页面里有选中的文字（如检查器中的识别结果）时，保留浏览器的复制文字
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        void copySelection();
      } else if (mod && key === "d") {
        e.preventDefault();
        s.duplicate(s.selectedIds);
      } else if (key === "t" && !mod) {
        s.addElements([newTextCard(viewCenterWorld())], { edit: true });
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    const onPaste = (e: ClipboardEvent) => {
      if (app().searchOpen || isTyping(e.target) || !canvas().doc) return;
      e.preventDefault();
      // 浏览器提供的剪贴板数据只能在事件内同步读取，先取出来作为后备
      const fallback = {
        files: Array.from(e.clipboardData?.files ?? []),
        text: e.clipboardData?.getData("text/plain") ?? "",
      };
      void pasteIntoCanvas(pasteAnchor(), fallback);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [fitAll, zoomBy, viewCenterWorld, pasteAnchor]);

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
      // 拖动分组框时，带上框内的元素
      const moving = new Set(ids);
      for (const sec of s.doc.elements) {
        if (sec.type !== "section" || !moving.has(sec.id)) continue;
        for (const other of s.doc.elements) if (other.id !== sec.id && contains(sec, other)) moving.add(other.id);
      }
      const origins = new Map<ID, Point>();
      for (const el of s.doc.elements) if (moving.has(el.id)) origins.set(el.id, { x: el.x, y: el.y });
      // 真正拖动后才捕获指针：过早捕获会让双击事件落到画布背景上
      gesture.current = { kind: "drag", start: toWorld(e), origins, moved: false };
    },
    onResizeStart(e, id) {
      e.stopPropagation();
      const el = canvas().doc?.elements.find((x) => x.id === id);
      if (!el) return;
      const ratio = el.type === "image" ? el.height / el.width : undefined;
      gesture.current = { kind: "resize", id, start: toWorld(e), width: el.width, height: el.height, ratio };
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
      else if (el.type === "section") canvas().setEditing(id);
      else {
        const asset = app().assets.get(el.assetId);
        if (!asset) app().showToast(t("找不到这个文件"));
        else void backend.openAsset(asset).catch((err) => app().showToast(t("无法打开文件：{error}", { error: String(err) })));
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
      } else if (el.type === "section" && value !== el.label) {
        s.updateElements({ [id]: { label: value } });
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
          s.beginGesture();
          capture(e);
        }
        const patches: Record<ID, Point> = {};
        for (const [id, o] of g.origins) patches[id] = { x: o.x + dx, y: o.y + dy };
        s.updateDuringGesture(patches);
        break;
      }
      case "marquee": {
        const r = normalizeRect(g.start, toWorld(e));
        setMarquee(r);
        const hit = s.doc.elements
          .filter((el) => (el.type === "section" ? contains(r, el) : intersects(r, el)))
          .map((el) => el.id);
        s.select([...new Set([...g.base, ...hit])]);
        break;
      }
      case "resize": {
        const w = toWorld(e);
        const width = Math.max(80, g.width + w.x - g.start.x);
        const height = g.ratio ? width * g.ratio : Math.max(48, g.height + w.y - g.start.y);
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
    if (g.kind === "drag" && g.moved) s.endGesture();
    else if (g.kind === "resize") s.endGesture();
    else if (g.kind === "marquee") setMarquee(null);
    else if (g.kind === "pan") setPanning(false);
    else if (g.kind === "connect") {
      setPendingEdge(null);
      const target = hitTest(s.doc.elements, toWorld(e), g.fromId);
      if (target) s.addEdge(g.fromId, target.id);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!canvas().doc || (e.target as HTMLElement).closest("[data-element-id], .canvas-toolbar, .minimap")) return;
    canvas().addElements([newTextCard(toWorld(e))], { edit: true });
  };

  // ---- 右键菜单：画布空白处与连线 ----
  const onBackgroundMenu = (e: ReactMouseEvent) => {
    if (!canvas().doc || (e.target as HTMLElement).closest("[data-element-id], .canvas-toolbar, .minimap, .find-bar")) return;
    const at = toWorld(e);
    canvas().select([]);
    openContextMenu(e, [
      {
        label: t("在此新建文本卡片"),
        icon: <StickyNote size={15} />,
        hint: t("双击"),
        onSelect: () => canvas().addElements([newTextCard(at)], { edit: true }),
      },
      { label: t("在此新建空文件夹"), icon: <FolderPlus size={15} />, onSelect: () => canvas().addElements([newFolder(at)], { edit: true }) },
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
        onSelect: () => canvas().select(canvas().doc!.elements.map((el) => el.id)),
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
            if (files.length) void placeAssets(() => backend.importBlobs(files), toWorld(e));
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

  /** 把元素移到视口中央（缩得太小时放大到 100%），选中并闪一下 */
  const revealElement = useCallback(
    (id: ID, select = true) => {
      const el = canvas().doc?.elements.find((e) => e.id === id);
      if (!el || size.w === 0) return;
      const vp = canvas().viewport;
      const zoom = vp.zoom < 0.5 ? 1 : vp.zoom;
      canvas().setViewport({
        zoom,
        x: size.w / 2 - (el.x + el.width / 2) * zoom,
        y: size.h / 2 - (el.y + el.height / 2) * zoom,
      });
      if (select) canvas().select([id]);
      setHighlightId(id);
      window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setHighlightId(null), 1600);
    },
    [size],
  );

  // 输入查询或按上一个 / 下一个时定位；编辑画布导致结果变化时不跳，以免打断用户
  const currentMatch = matches.length ? matches[Math.min(find.index, matches.length - 1)] : undefined;
  useEffect(() => {
    if (find.open && currentMatch) revealElement(currentMatch);
  }, [find.nav]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const visible = useMemo(() => {
    if (!doc || !cull) return [];
    return doc.elements.filter((el) => intersects(cull.rect, el) || selectedSet.has(el.id) || el.id === editingId);
  }, [doc, cull, selectedSet, editingId]);

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
        matched={matchSet.has(el.id)}
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
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onBackgroundMenu}
      {...browserDrop}
    >
      {/* transform 由上面的视口订阅直接写入，不经过 React */}
      <div className="canvas-world" ref={worldRef}>
        {visible.filter((e) => e.type === "section").map(renderEl)}
        <EdgeLayer
          edges={doc.edges}
          elements={doc.elements}
          selectedEdgeId={selectedEdgeId}
          pending={pendingEdge}
          onSelect={onEdgeSelect}
          onContextMenu={onEdgeMenu}
        />
        {visible.filter((e) => e.type !== "section").map(renderEl)}
        {marquee && (
          <div
            className="marquee"
            style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.width, height: marquee.height }}
          />
        )}
      </div>

      {doc.elements.length === 0 && (
        <div className="canvas-empty">
          <p>{t("双击空白处新建卡片")}</p>
          <p>{t("或把文件、图片拖进来")}</p>
        </div>
      )}

      {minimapOpen && <Minimap elements={doc.elements} screen={size} />}

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
        onAddFolder={() => void pickFiles(undefined, true)}
        onNewFolder={() => canvas().addElements([newFolder(viewCenterWorld())], { edit: true })}
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
