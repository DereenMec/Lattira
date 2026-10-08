import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Group, Map as MapIcon, Maximize, Minus, Paperclip, Plus, Redo2, StickyNote, Undo2 } from "lucide-react";
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
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID, Viewport } from "@/types/model";
import { EdgeLayer } from "./EdgeLayer";
import { ElementView, type ElementHandlers } from "./ElementView";
import { Minimap } from "./Minimap";
import { elementsForAssets, newTextCard } from "./placement";

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
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [pendingEdge, setPendingEdge] = useState<{ fromId: ID; to: Point } | null>(null);
  const [panning, setPanning] = useState(false);
  const [highlightId, setHighlightId] = useState<ID | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const loaded = doc?.canvasId === canvasId;

  // ---- 加载与离开 ----
  useEffect(() => {
    canvas()
      .load(canvasId)
      .catch((e) => app().showToast(`打开画布失败：${String(e)}`));
    return () => void canvas().flush();
  }, [canvasId]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

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
    const t = window.setTimeout(() => setHighlightId(null), 1600);
    return () => window.clearTimeout(t);
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

  // ---- 导入文件 ----
  const placeAssets = useCallback(async (load: () => Promise<Asset[]>, at: Point) => {
    try {
      const imported = await load();
      if (imported.length === 0) return;
      app().addAssets(imported);
      canvas().addElements(elementsForAssets(imported, at));
    } catch (e) {
      app().showToast(`导入失败：${String(e)}`);
    }
  }, []);

  const pickFiles = useCallback(async () => {
    if (!canvas().doc) return;
    const at = viewCenterWorld();
    if (backend.kind === "tauri") {
      const picked = await open({ multiple: true, title: "选择要放到画布上的文件" });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) await placeAssets(() => backend.importPaths(paths), at);
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
  }, [placeAssets, viewCenterWorld]);

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
          void placeAssets(() => backend.importPaths(p.paths), at);
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
  }, [placeAssets, toWorld]);

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
        if (el && (el.type === "text" || el.type === "section")) {
          e.preventDefault();
          s.setEditing(el.id);
        }
      } else if (key === "t" && !mod) {
        s.addElements([newTextCard(viewCenterWorld())], { edit: true });
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    const onPaste = (e: ClipboardEvent) => {
      if (app().searchOpen || isTyping(e.target) || !canvas().doc || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files);
      const at = viewCenterWorld();
      if (files.length > 0) {
        e.preventDefault();
        void placeAssets(() => backend.importBlobs(files), at);
        return;
      }
      const text = e.clipboardData.getData("text/plain");
      if (text.trim()) {
        e.preventDefault();
        canvas().addElements([newTextCard(at, text)]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [fitAll, zoomBy, placeAssets, viewCenterWorld]);

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
      if (el.type === "text" || el.type === "section") canvas().setEditing(id);
      else {
        const asset = app().assets.get(el.assetId);
        if (!asset) app().showToast("找不到这个文件");
        else void backend.openAsset(asset).catch((err) => app().showToast(`无法打开文件：${String(err)}`));
      }
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
    }),
    [],
  );

  const onPointerMove = (e: ReactPointerEvent) => {
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
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
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
          onSelect={(id) => canvas().selectEdge(id)}
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
          <p>双击空白处新建卡片</p>
          <p>或把文件、图片拖进来</p>
        </div>
      )}

      {minimapOpen && <Minimap elements={doc.elements} screen={size} />}

      <Toolbar
        minimapOpen={minimapOpen}
        onAddText={() => canvas().addElements([newTextCard(viewCenterWorld())], { edit: true })}
        onAddFiles={() => void pickFiles()}
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
  onGroup(): void;
  onZoom(factor: number): void;
  onFit(): void;
}) {
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const hasSelection = useCanvasStore((s) => s.selectedIds.length > 0);
  // 只订阅百分比，平移时工具栏不会重新渲染
  const zoomPercent = useCanvasStore((s) => Math.round(s.viewport.zoom * 100));
  const stop = (e: ReactPointerEvent) => e.stopPropagation();
  return (
    <div className="canvas-toolbar" onPointerDown={stop} onDoubleClick={(e) => e.stopPropagation()}>
      <button className="tb-btn" onClick={props.onAddText} title="新建文本卡片（T）">
        <StickyNote size={16} />
        <span>文本</span>
      </button>
      <button className="tb-btn" onClick={props.onAddFiles} title="插入文件或图片">
        <Paperclip size={16} />
        <span>文件</span>
      </button>
      <button className="tb-btn" onClick={props.onGroup} disabled={!hasSelection} title="把选中的卡片放进分组框（Ctrl+G）">
        <Group size={16} />
        <span>分组</span>
      </button>
      <span className="tb-sep" />
      <button className="tb-icon" onClick={() => canvas().undo()} disabled={!canUndo} title="撤销（Ctrl+Z）">
        <Undo2 size={16} />
      </button>
      <button className="tb-icon" onClick={() => canvas().redo()} disabled={!canRedo} title="重做（Ctrl+Shift+Z）">
        <Redo2 size={16} />
      </button>
      <span className="tb-sep" />
      <button className="tb-icon" onClick={() => props.onZoom(0.8)} title="缩小（Ctrl+-）">
        <Minus size={16} />
      </button>
      <button className="tb-zoom" onClick={() => props.onZoom(100 / zoomPercent)} title="恢复 100%（Ctrl+0）">
        {zoomPercent}%
      </button>
      <button className="tb-icon" onClick={() => props.onZoom(1.25)} title="放大（Ctrl+=）">
        <Plus size={16} />
      </button>
      <button className="tb-icon" onClick={props.onFit} title="显示全部内容（Shift+1）">
        <Maximize size={16} />
      </button>
      <button
        className={`tb-icon${props.minimapOpen ? " is-on" : ""}`}
        onClick={() => useAppStore.getState().toggleMinimap()}
        title="显示 / 隐藏小地图"
      >
        <MapIcon size={16} />
      </button>
    </div>
  );
}
