import { ArrowUpRight, ExternalLink, LocateFixed } from "lucide-react";
import { useMemo } from "react";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { assetEntries } from "@/features/menu/menus";
import { msg, useT } from "@/i18n";
import { formatRelative } from "@/lib/date";
import { fileIconUrl } from "@/lib/fileIcons";
import { formatBytes, isImageMime, isOcrMime } from "@/lib/format";
import { backend } from "@/services/backend";
import { projectLabel, useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useSettings } from "@/store/settingsStore";
import { CARD_COLORS, type Asset, type CanvasMeta, type CardColor, type ID } from "@/types/model";

const TYPE_LABEL = { text: msg("文本卡片"), image: msg("图片"), file: msg("文件"), section: msg("文件夹") } as const;

/**
 * 当前画布引用的全部文件与图片；单击定位到卡片，双击打开，右键更多操作。
 * 单击只定位、不选中：选中卡片会让检查器切换到卡片属性，列表随之消失，双击的第二下就点不到了。
 */
function CanvasFileList() {
  const t = useT();
  const elements = useCanvasStore((s) => s.doc?.elements);
  const assets = useAppStore((s) => s.assets);

  const rows = useMemo(() => {
    const byAsset = new Map<ID, { asset: Asset; elementIds: ID[] }>();
    for (const el of elements ?? []) {
      if (el.type !== "image" && el.type !== "file") continue;
      const asset = assets.get(el.assetId);
      if (!asset) continue;
      const row = byAsset.get(asset.id) ?? { asset, elementIds: [] };
      row.elementIds.push(el.id);
      byAsset.set(asset.id, row);
    }
    return [...byAsset.values()].sort((a, b) => a.asset.name.localeCompare(b.asset.name, "zh-CN"));
  }, [elements, assets]);

  const total = rows.reduce((sum, r) => sum + r.asset.size, 0);

  return (
    <section>
      <h3>
        {t("画布中的文件")}{" "}
        <span className="h3-sub">{rows.length ? t("{n} 个 · {size}", { n: rows.length, size: formatBytes(total) }) : ""}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="hint">{t("把文件或图片拖进画布后，会列在这里。")}</p>
      ) : (
        <ul className="file-list">
          {rows.map(({ asset, elementIds }) => (
            <li key={asset.id}>
              <button
                title={`${asset.name}\n${t("单击定位 · 双击打开 · 右键更多")}`}
                onClick={() => useCanvasStore.getState().requestFocus(elementIds[0], { select: false })}
                onDoubleClick={() => void backend.openAsset(asset)}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: t("在画布中定位"), icon: <LocateFixed size={15} />, onSelect: () => useCanvasStore.getState().requestFocus(elementIds[0]) },
                    "separator",
                    ...assetEntries(asset),
                  ])
                }
              >
                {isImageMime(asset.mime) && backend.assetUrl(asset) ? (
                  <img className="file-list-thumb" src={backend.assetUrl(asset)} alt="" loading="lazy" />
                ) : (
                  <img className="file-list-icon" src={fileIconUrl(asset.name)} alt="" />
                )}
                <span className="file-list-name">{asset.name}</span>
                <span className="file-list-size">{formatBytes(asset.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Inspector({ meta }: { meta: CanvasMeta }) {
  const t = useT();
  const doc = useCanvasStore((s) => s.doc);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const assets = useAppStore((s) => s.assets);
  const projects = useAppStore((s) => s.projects);
  const width = useSettings((s) => s.inspectorWidth);

  if (!doc) return <aside className="inspector" style={{ width }} />;
  const { updateCanvas, navigate, showToast } = useAppStore.getState();
  const selected = doc.elements.filter((e) => selectedIds.includes(e.id));
  const colorable = selected.filter((e) => e.type === "text" || e.type === "section");

  const setColor = (color: CardColor) =>
    useCanvasStore.getState().updateElements(Object.fromEntries(colorable.map((e) => [e.id, { color }])));

  return (
    <aside className="inspector" style={{ width }}>
      {selected.length === 0 && !selectedEdgeId && (
        <section>
          <h3>{t("画布")}</h3>
          <dl className="props">
            <dt>{t("所属项目")}</dt>
            <dd className="project-field">
              <select
                value={meta.projectId}
                title={t("移到其他项目")}
                onChange={(e) =>
                  void updateCanvas(meta.id, { projectId: e.target.value }).catch((err) =>
                    showToast(t("移动失败：{error}", { error: String(err) })),
                  )
                }
              >
                {projects
                  .filter((p) => !p.archived || p.id === meta.projectId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
              </select>
              <button className="icon-btn" title={t("打开项目")} onClick={() => navigate({ kind: "project", projectId: meta.projectId })}>
                <ArrowUpRight size={14} />
              </button>
            </dd>
            <dt>{t("元素")}</dt>
            <dd>{t("{n} 个", { n: doc.elements.length })}</dd>
            <dt>{t("连线")}</dt>
            <dd>{t("{n} 条", { n: doc.edges.length })}</dd>
            <dt>{t("创建于")}</dt>
            <dd>{formatRelative(meta.createdAt)}</dd>
            <dt>{t("最后编辑")}</dt>
            <dd>{formatRelative(meta.updatedAt)}</dd>
          </dl>
          <p className="hint">{t("选中卡片后，这里显示它的属性。")}</p>
        </section>
      )}

      {selected.length === 0 && !selectedEdgeId && <CanvasFileList />}

      {selectedEdgeId && (
        <section>
          <h3>{t("连线")}</h3>
          <p className="hint">{t("按 Delete 删除这条连线。")}</p>
        </section>
      )}

      {selected.length === 1 && (
        <section>
          <h3>{t(TYPE_LABEL[selected[0].type])}</h3>
          <dl className="props">
            <dt>{t("尺寸")}</dt>
            <dd>
              {Math.round(selected[0].width)} × {Math.round(selected[0].height)}
            </dd>
            <dt>{t("创建于")}</dt>
            <dd>{formatRelative(selected[0].createdAt)}</dd>
            <dt>{t("修改于")}</dt>
            <dd>{formatRelative(selected[0].updatedAt)}</dd>
          </dl>
          {(selected[0].type === "image" || selected[0].type === "file") &&
            (() => {
              const asset = assets.get(selected[0].assetId);
              if (!asset) return <p className="hint">{t("找不到对应的文件。")}</p>;
              return (
                <>
                  <h3>{t("文件")}</h3>
                  <dl className="props">
                    <dt>{t("名称")}</dt>
                    <dd className="break">{asset.name}</dd>
                    <dt>{t("大小")}</dt>
                    <dd>{formatBytes(asset.size)}</dd>
                    {asset.width && (
                      <>
                        <dt>{t("像素")}</dt>
                        <dd>
                          {asset.width} × {asset.height}
                        </dd>
                      </>
                    )}
                    <dt>{t("位置")}</dt>
                    <dd className="break mono">{asset.path}</dd>
                    <dt>{t("引用")}</dt>
                    <dd>{t("{n} 个画布", { n: asset.refCount })}</dd>
                  </dl>
                  <button className="btn" onClick={() => void backend.openAsset(asset)}>
                    <ExternalLink size={14} /> {t("用默认程序打开")}
                  </button>
                  {selected[0].type === "image" && isOcrMime(asset.mime) && asset.ocrText !== undefined && (
                    <>
                      <h3 className="spaced">{t("图中文字")}</h3>
                      {asset.ocrText === null ? (
                        <p className="hint">{t("正在识别…")}</p>
                      ) : asset.ocrText ? (
                        <pre className="ocr-text">{asset.ocrText}</pre>
                      ) : (
                        <p className="hint">{t("没有识别到文字。")}</p>
                      )}
                    </>
                  )}
                </>
              );
            })()}
        </section>
      )}

      {selected.length > 1 && (
        <section>
          <h3>{t("已选 {n} 个元素", { n: selected.length })}</h3>
          <p className="hint">{t("Ctrl+G 放进文件夹，Delete 删除。")}</p>
        </section>
      )}

      {colorable.length > 0 && (
        <section>
          <h3>{t("颜色")}</h3>
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
