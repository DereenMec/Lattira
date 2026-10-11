import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useT } from "@/i18n";
import { canvasAncestor, childrenOf, isFolder } from "@/lib/folders";
import { linkText } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID } from "@/types/model";

/** 元素中可被查找的文字：卡片正文、文件夹名、链接标题与网址、文件名、图片名与图中文字 */
function searchableText(el: CanvasElement, assets: ReadonlyMap<ID, Asset>): string {
  switch (el.type) {
    case "text":
      return el.text;
    case "folder":
      return el.label;
    case "link":
      return linkText(el);
    case "file":
      return assets.get(el.assetId)?.name ?? "";
    case "image": {
      const a = assets.get(el.assetId);
      return a ? `${a.name}\n${a.ocrText ?? ""}` : "";
    }
  }
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** 元素本身是否命中查询 */
export function elementMatches(el: CanvasElement, assets: ReadonlyMap<ID, Asset>, query: string): boolean {
  const q = normalize(query);
  return !!q && normalize(searchableText(el, assets)).includes(q);
}

/**
 * 当前画布中命中查询的元素，包括文件夹（及子文件夹）里的。
 * 按画布上的位置从上到下、从左到右排序；同一个文件夹里的，按文件夹窗口里的顺序（子文件夹逐层展开）排在文件夹之后。
 */
export function findMatches(elements: CanvasElement[], assets: ReadonlyMap<ID, Asset>, query: string): ID[] {
  // 忽略空白：OCR 结果里的空格和换行不影响匹配
  if (!normalize(query)) return [];
  const hits = elements.filter((el) => elementMatches(el, assets, query));
  if (hits.length === 0) return [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  // 文件夹里每一项在窗口中的先后：深度优先，与 childrenOf 的顺序一致
  const order = new Map<ID, number>();
  const visit = (folderId: ID) => {
    for (const child of childrenOf(elements, folderId)) {
      order.set(child.id, order.size);
      if (isFolder(child)) visit(child.id);
    }
  };
  if (hits.some((el) => el.parentId)) for (const el of elements) if (!el.parentId && isFolder(el)) visit(el.id);
  const keyed = hits.flatMap((el) => {
    const shown = canvasAncestor(byId, el.id);
    return shown ? [{ el, shown, depth: el.parentId ? (order.get(el.id) ?? 0) + 1 : 0 }] : [];
  });
  return keyed
    .sort((a, b) => a.shown.y - b.shown.y || a.shown.x - b.shown.x || (a.shown === b.shown ? a.depth - b.depth : 0))
    .map((k) => k.el.id);
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
