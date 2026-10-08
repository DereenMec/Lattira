import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useT } from "@/i18n";
import type { Asset, CanvasElement, ID } from "@/types/model";

/** 元素中可被查找的文字：卡片正文、分组标题、文件名、图片名与图中文字 */
function searchableText(el: CanvasElement, assets: ReadonlyMap<ID, Asset>): string {
  switch (el.type) {
    case "text":
      return el.text;
    case "section":
      return el.label;
    case "file":
      return assets.get(el.assetId)?.name ?? "";
    case "image": {
      const a = assets.get(el.assetId);
      return a ? `${a.name}\n${a.ocrText ?? ""}` : "";
    }
  }
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** 当前画布中命中查询的元素，按从上到下、从左到右排序 */
export function findMatches(elements: CanvasElement[], assets: ReadonlyMap<ID, Asset>, query: string): ID[] {
  // 忽略空白：OCR 结果里的空格和换行不影响匹配
  const q = normalize(query);
  if (!q) return [];
  return elements
    .filter((el) => normalize(searchableText(el, assets)).includes(q))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((el) => el.id);
}

interface Props {
  query: string;
  index: number;
  total: number;
  onQuery(q: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}

/** 画布内查找栏（Ctrl+F） */
export function FindBar({ query, index, total, onQuery, onStep, onClose }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="find-bar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        data-find-input
        value={query}
        placeholder={t("在此画布中查找（含图片中的文字）")}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            onClose();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            inputRef.current?.select();
          }
        }}
      />
      <span className="find-count">{query.trim() ? (total ? `${index + 1} / ${total}` : t("无结果")) : ""}</span>
      <button className="icon-btn" onClick={() => onStep(-1)} disabled={total === 0} title={t("上一个（Shift+Enter）")}>
        <ChevronUp size={16} />
      </button>
      <button className="icon-btn" onClick={() => onStep(1)} disabled={total === 0} title={t("下一个（Enter）")}>
        <ChevronDown size={16} />
      </button>
      <button className="icon-btn" onClick={onClose} title={t("关闭（Esc）")}>
        <X size={16} />
      </button>
    </div>
  );
}
