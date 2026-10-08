import { Shapes } from "lucide-react";
import { memo, useMemo } from "react";
import { boundsOf } from "@/lib/geometry";
import { parsePreview } from "@/lib/preview";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";

/** 画布缩略图：把精简布局缩放到卡片大小，用 SVG 画出来 */
function CanvasThumbImpl({ preview }: { preview?: string | null }) {
  const assets = useAppStore((s) => s.assets);
  const data = useMemo(() => parsePreview(preview), [preview]);
  const bounds = useMemo(
    () => (data ? boundsOf(data.items.map((i) => ({ x: i.x, y: i.y, width: i.w, height: i.h }))) : null),
    [data],
  );

  if (!data || !bounds) {
    return (
      <div className="thumb thumb-empty">
        <Shapes size={22} />
      </div>
    );
  }

  const pad = Math.max(bounds.width, bounds.height) * 0.06 + 20;
  const vb = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.width + pad * 2, h: bounds.height + pad * 2 };
  // 文字大小随画布尺寸放大，保证缩略图里大致可读
  const fontSize = Math.max(16, vb.w / 22);
  const center = (i: number) => {
    const it = data.items[i];
    return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  };

  return (
    <svg className="thumb" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet">
      {data.edges.map(([a, b], k) => {
        const p = center(a);
        const q = center(b);
        return <line key={k} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="thumb-edge" style={{ strokeWidth: vb.w / 300 }} />;
      })}
      {data.items.map((it, k) => {
        const asset = it.a ? assets.get(it.a) : undefined;
        const url = asset ? backend.assetUrl(asset) : "";
        const radius = Math.min(it.w, it.h) * 0.06;
        return (
          <g key={k}>
            <rect
              x={it.x}
              y={it.y}
              width={it.w}
              height={it.h}
              rx={radius}
              className={`thumb-item thumb-${it.t}${it.c ? ` color-${it.c}` : ""}`}
              style={{ strokeWidth: vb.w / 400 }}
            />
            {it.t === "i" && url && (
              <image href={url} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio="xMidYMid slice" />
            )}
            {it.l && it.w > vb.w / 12 && (
              <svg x={it.x} y={it.y} width={it.w} height={it.h}>
                <text x={fontSize * 0.6} y={fontSize * 1.4} fontSize={fontSize} className="thumb-text">
                  {it.l}
                </text>
              </svg>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export const CanvasThumb = memo(CanvasThumbImpl);
