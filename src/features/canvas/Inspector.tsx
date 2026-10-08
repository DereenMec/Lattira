import { ExternalLink } from "lucide-react";
import { formatRelative } from "@/lib/date";
import { formatBytes } from "@/lib/format";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { CARD_COLORS, type CanvasMeta, type CardColor } from "@/types/model";

const TYPE_LABEL = { text: "文本卡片", image: "图片", file: "文件", section: "分组框" } as const;

export function Inspector({ meta }: { meta: CanvasMeta }) {
  const doc = useCanvasStore((s) => s.doc);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const assets = useAppStore((s) => s.assets);
  const projects = useAppStore((s) => s.projects);

  if (!doc) return <aside className="inspector" />;
  const selected = doc.elements.filter((e) => selectedIds.includes(e.id));
  const colorable = selected.filter((e) => e.type === "text" || e.type === "section");

  const setColor = (color: CardColor) =>
    useCanvasStore.getState().updateElements(Object.fromEntries(colorable.map((e) => [e.id, { color }])));

  return (
    <aside className="inspector">
      {selected.length === 0 && !selectedEdgeId && (
        <section>
          <h3>画布</h3>
          <dl className="props">
            <dt>所属项目</dt>
            <dd>{projects.find((p) => p.id === meta.projectId)?.name}</dd>
            <dt>元素</dt>
            <dd>{doc.elements.length} 个</dd>
            <dt>连线</dt>
            <dd>{doc.edges.length} 条</dd>
            <dt>创建于</dt>
            <dd>{formatRelative(meta.createdAt)}</dd>
            <dt>最后编辑</dt>
            <dd>{formatRelative(meta.updatedAt)}</dd>
          </dl>
          <p className="hint">选中卡片后，这里显示它的属性。</p>
        </section>
      )}

      {selectedEdgeId && (
        <section>
          <h3>连线</h3>
          <p className="hint">按 Delete 删除这条连线。</p>
        </section>
      )}

      {selected.length === 1 && (
        <section>
          <h3>{TYPE_LABEL[selected[0].type]}</h3>
          <dl className="props">
            <dt>尺寸</dt>
            <dd>
              {Math.round(selected[0].width)} × {Math.round(selected[0].height)}
            </dd>
            <dt>创建于</dt>
            <dd>{formatRelative(selected[0].createdAt)}</dd>
            <dt>修改于</dt>
            <dd>{formatRelative(selected[0].updatedAt)}</dd>
          </dl>
          {(selected[0].type === "image" || selected[0].type === "file") &&
            (() => {
              const asset = assets.get(selected[0].assetId);
              if (!asset) return <p className="hint">找不到对应的文件。</p>;
              return (
                <>
                  <h3>文件</h3>
                  <dl className="props">
                    <dt>名称</dt>
                    <dd className="break">{asset.name}</dd>
                    <dt>大小</dt>
                    <dd>{formatBytes(asset.size)}</dd>
                    {asset.width && (
                      <>
                        <dt>像素</dt>
                        <dd>
                          {asset.width} × {asset.height}
                        </dd>
                      </>
                    )}
                    <dt>位置</dt>
                    <dd className="break mono">{asset.path}</dd>
                    <dt>引用</dt>
                    <dd>{asset.refCount} 个画布</dd>
                  </dl>
                  <button className="btn" onClick={() => void backend.openAsset(asset)}>
                    <ExternalLink size={14} /> 用默认程序打开
                  </button>
                </>
              );
            })()}
        </section>
      )}

      {selected.length > 1 && (
        <section>
          <h3>已选 {selected.length} 个元素</h3>
          <p className="hint">Ctrl+G 放进分组框，Delete 删除。</p>
        </section>
      )}

      {colorable.length > 0 && (
        <section>
          <h3>颜色</h3>
          <div className="swatches">
            {CARD_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch color-${c}${colorable.every((e) => (e.color ?? "default") === c) ? " is-active" : ""}`}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
