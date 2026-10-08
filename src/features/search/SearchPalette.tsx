import { FileText, Search, Shapes, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import type { SearchHit } from "@/types/model";

const KIND_ICON = { canvas: Shapes, text: Type, file: FileText } as const;
const KIND_LABEL = { canvas: "画布", text: "文本", file: "文件" } as const;

export function SearchPalette() {
  const projects = useAppStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      backend
        .search(q)
        .then((r) => {
          if (!alive) return;
          setHits(r);
          setActive(0);
        })
        .catch((e) => useAppStore.getState().showToast(`搜索失败：${String(e)}`));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const close = () => useAppStore.getState().setSearchOpen(false);
  const go = (hit: SearchHit) => {
    close();
    useAppStore.getState().navigate({ kind: "canvas", canvasId: hit.canvasId, focusElementId: hit.elementId });
  };

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索画布名、卡片文字、文件名"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
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
            {hits.length === 0 && <li className="palette-empty">没有找到「{query.trim()}」</li>}
            {hits.map((h, i) => {
              const Icon = KIND_ICON[h.kind];
              const project = projects.find((p) => p.id === h.projectId);
              return (
                <li key={`${h.kind}-${h.canvasId}-${h.elementId ?? i}`}>
                  <button className={i === active ? "is-active" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(h)}>
                    <Icon size={15} />
                    <span className="hit-snippet">{h.snippet}</span>
                    <span className="hit-meta">
                      {KIND_LABEL[h.kind]} · {project?.name} / {h.canvasTitle}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
