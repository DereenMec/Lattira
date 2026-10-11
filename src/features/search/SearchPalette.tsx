import { FileText, Image as ImageIcon, Search, Shapes, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/services/backend";
import { msg, useT } from "@/i18n";
import { projectLabel, useAppStore } from "@/store/appStore";
import type { SearchHit } from "@/types/model";
import { Highlight } from "./Highlight";
import { useDialog } from "@/features/menu/useDialog";

const KIND_ICON = { canvas: Shapes, text: Type, file: FileText, image: ImageIcon } as const;
const KIND_LABEL = { canvas: msg("画布"), text: msg("文本"), file: msg("文件"), image: msg("图中文字") } as const;

export function SearchPalette() {
  const t = useT();
  const projects = useAppStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  // 当前结果对应的查询词：输入还没停下来时，高亮仍按显示中的结果来
  const [hitsQuery, setHitsQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, true);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    request.current++;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setHasMore(false);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      backend
        .search(q)
        .then((r) => {
          if (!alive) return;
          setHits(r.slice(0, 50));
          setHasMore(r.length > 50);
          setHitsQuery(q);
          setActive(0);
        })
        .catch((e) => useAppStore.getState().showToast(t("搜索失败：{error}", { error: String(e) })));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const close = () => useAppStore.getState().setSearchOpen(false);
  const more = async () => {
    const version = request.current;
    setLoadingMore(true);
    try {
      const next = await backend.search(hitsQuery, hits.length);
      if (version !== request.current) return;
      setHits((previous) => [...previous, ...next.slice(0, 50)]);
      setHasMore(next.length > 50);
    } catch (e) { useAppStore.getState().showToast(String(e)); }
    finally { setLoadingMore(false); }
  };
  const go = (hit: SearchHit) => {
    close();
    useAppStore.getState().navigate({
      kind: "canvas",
      canvasId: hit.canvasId,
      focusElementId: hit.elementId ?? undefined,
      focusAssetId: hit.assetId ?? undefined,
      // 命中画布名时不必在画布里查找
      findQuery: hit.kind === "canvas" ? undefined : hitsQuery,
    });
  };

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("搜索")} ref={dialogRef} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (!e.nativeEvent.isComposing && e.key === "Escape") close(); }}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t("搜索画布名、卡片文字、文件名、图片中的文字")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && hits[active]) go(hits[active]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        {query.trim() && (
          <ul className="palette-results">
            {hits.length === 0 && <li className="palette-empty">{t("没有找到「{q}」", { q: query.trim() })}</li>}
            {hits.map((h, i) => {
              const Icon = KIND_ICON[h.kind];
              const project = projects.find((p) => p.id === h.projectId);
              return (
                <li key={`${h.kind}-${h.canvasId}-${h.elementId ?? h.assetId ?? i}`}>
                  <button className={i === active ? "is-active" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(h)}>
                    <Icon size={15} />
                    <span className="hit-snippet">
                      <Highlight text={h.snippet} query={hitsQuery} />
                    </span>
                    <span className="hit-meta">
                      {t(KIND_LABEL[h.kind])} · {project ? projectLabel(project) : ""} / {h.canvasTitle}
                    </span>
                  </button>
                </li>
              );
            })}
            {hasMore && <li><button onClick={() => void more()} disabled={loadingMore || query.trim() !== hitsQuery}>{t("加载更多")}</button></li>}
          </ul>
        )}
      </div>
    </div>
  );
}
