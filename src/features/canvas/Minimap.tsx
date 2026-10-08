import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { boundsOf } from "@/lib/geometry";
import { useCanvasStore } from "@/store/canvasStore";
import type { CanvasElement } from "@/types/model";

const WIDTH = 200;
const HEIGHT = 140;
const INSET = 6;

/**
 * 右下角小地图：内容画在 2D canvas 上，只在元素变化时重画；视口框是一个绝对定位的 div。
 * 平移时只移动视口框，几千个元素也不会拖慢每一帧。
 */
export function Minimap({ elements, screen }: { elements: CanvasElement[]; screen: { w: number; h: number } }) {
  const viewport = useCanvasStore((s) => s.viewport);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  // 内容范围加一圈留白，作为小地图的固定坐标系
  const frame = useMemo(() => {
    const b = boundsOf(elements);
    if (!b) return null;
    const pad = Math.max(b.width, b.height) * 0.08 + 40;
    const x = b.x - pad;
    const y = b.y - pad;
    const w = b.width + pad * 2;
    const h = b.height + pad * 2;
    const scale = Math.min((WIDTH - INSET * 2) / w, (HEIGHT - INSET * 2) / h);
    return { x, y, scale, ox: (WIDTH - w * scale) / 2, oy: (HEIGHT - h * scale) / 2 };
  }, [elements]);

  const shown = !!frame && screen.w > 0;

  useEffect(() => {
    const node = canvasRef.current;
    const ctx = node?.getContext("2d");
    if (!node || !ctx || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    node.width = WIDTH * dpr;
    node.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const css = getComputedStyle(node);
    const fill = css.getPropertyValue("--ink-3").trim() || "#999";
    const accent = css.getPropertyValue("--accent").trim() || "#2f5d50";
    for (const el of elements) {
      const x = frame.ox + (el.x - frame.x) * frame.scale;
      const y = frame.oy + (el.y - frame.y) * frame.scale;
      const w = Math.max(1, el.width * frame.scale);
      const h = Math.max(1, el.height * frame.scale);
      if (el.type === "section") {
        ctx.strokeStyle = fill;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      } else {
        ctx.fillStyle = el.type === "image" ? accent : fill;
        ctx.globalAlpha = el.type === "image" ? 0.55 : 1;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }
    }
  }, [elements, frame, shown]);

  if (!frame || !shown) return null;

  // 视口框，超出小地图的部分裁掉
  const vx = frame.ox + (-viewport.x / viewport.zoom - frame.x) * frame.scale;
  const vy = frame.oy + (-viewport.y / viewport.zoom - frame.y) * frame.scale;
  const vw = (screen.w / viewport.zoom) * frame.scale;
  const vh = (screen.h / viewport.zoom) * frame.scale;
  const left = Math.max(0, vx);
  const top = Math.max(0, vy);
  const right = Math.min(WIDTH, vx + vw);
  const bottom = Math.min(HEIGHT, vy + vh);

  const centerOn = (e: ReactPointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const wx = frame.x + (e.clientX - r.left - frame.ox) / frame.scale;
    const wy = frame.y + (e.clientY - r.top - frame.oy) / frame.scale;
    useCanvasStore.getState().setViewport({
      zoom: viewport.zoom,
      x: screen.w / 2 - wx * viewport.zoom,
      y: screen.h / 2 - wy * viewport.zoom,
    });
  };

  return (
    <div
      className="minimap"
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        centerOn(e);
      }}
      onPointerMove={(e) => dragging.current && centerOn(e)}
      onPointerUp={() => (dragging.current = false)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} />
      {right > left && bottom > top && (
        <div className="mm-view" style={{ left: left + 4, top: top + 4, width: right - left, height: bottom - top }} />
      )}
    </div>
  );
}
