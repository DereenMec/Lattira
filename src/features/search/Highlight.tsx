import { Fragment, type ReactNode } from "react";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * text 中与 query 匹配的区间。与画布内查找一致：不区分大小写、忽略空白
 * （OCR 结果里常夹着空格和换行，「项目进度」也要能对上「项目 进度」）。
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const chars = [...query.replace(/\s+/g, "")];
  if (chars.length === 0 || !text) return [];
  const re = new RegExp(chars.map(escapeRegExp).join("\\s*"), "giu");
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** 把命中的部分包在 <mark> 里；没有命中时原样返回文字 */
export function Highlight({ text, query }: { text: string; query?: string }) {
  const ranges = query ? matchRanges(text, query) : [];
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([start, end], i) => {
    if (start > last) parts.push(<Fragment key={`t${i}`}>{text.slice(last, start)}</Fragment>);
    parts.push(
      <mark key={`m${i}`} className="hit">
        {text.slice(start, end)}
      </mark>,
    );
    last = end;
  });
  if (last < text.length) parts.push(<Fragment key="tail">{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
