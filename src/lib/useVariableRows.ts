import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { rowOffsets, visibleRows } from "./variableRows";

/** The tbody origin excludes the sticky header from the data row offsets. */
export function useVariableRows(ref: RefObject<HTMLElement | null>, heights: readonly number[]) {
  const offsets = useMemo(() => rowOffsets(heights), [heights]);
  const [view, setView] = useState({ offset: 0, viewport: 600 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let scroll = node.parentElement!;
    while (!/auto|scroll/.test(getComputedStyle(scroll).overflowY) && scroll.parentElement) scroll = scroll.parentElement;
    const update = () => {
      const offset = Math.max(0, scroll.getBoundingClientRect().top - node.getBoundingClientRect().top);
      const viewport = scroll.clientHeight;
      setView((old) => old.offset === offset && old.viewport === viewport ? old : { offset, viewport });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node); observer.observe(scroll);
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", update); };
  }, [ref, offsets]);
  return visibleRows(offsets, view.offset, view.viewport);
}
