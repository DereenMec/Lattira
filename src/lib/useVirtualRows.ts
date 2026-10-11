import { useLayoutEffect, useState, type RefObject } from "react";

/** Window fixed-height rows in either a scroll container or a scrolling ancestor. */
export function useVirtualRows(ref: RefObject<HTMLElement | null>, count: number, height: number, minWidth = Infinity, gap = 0) {
  const [window, setWindow] = useState({ start: 0, end: 40, columns: 1 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let scroll: HTMLElement = node;
    while (!/auto|scroll/.test(getComputedStyle(scroll).overflowY) && scroll.parentElement) scroll = scroll.parentElement;
    const update = () => {
      const box = node.getBoundingClientRect();
      const clip = scroll.getBoundingClientRect();
      const style = getComputedStyle(node);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const columns = Number.isFinite(minWidth) ? Math.max(1, Math.floor((node.clientWidth - padding + gap) / (minWidth + gap))) : 1;
      const offset = scroll === node ? node.scrollTop : Math.max(0, clip.top - box.top);
      const row = Math.max(0, Math.floor(offset / height) - 3);
      const rows = Math.ceil(scroll.clientHeight / height) + 7;
      const start = Math.min(row * columns, Math.max(0, Math.ceil(count / columns) - 1) * columns);
      const end = Math.min(count, start + rows * columns);
      setWindow((old) => old.start === start && old.end === end && old.columns === columns ? old : { start, end, columns });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node); observer.observe(scroll);
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", update); };
  }, [ref, count, height, minWidth, gap]);
  const { start, end, columns } = window;
  return { start, end, top: Math.floor(start / columns) * height, bottom: Math.max(0, Math.ceil(count / columns) - Math.ceil(end / columns)) * height };
}
