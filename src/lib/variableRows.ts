/** Prefix offsets let mixed-height rows retain their exact scroll positions. */
export function rowOffsets(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  return offsets;
}

export function visibleRows(offsets: readonly number[], offset: number, viewport: number, overscan = 3) {
  const count = offsets.length - 1;
  if (!count) return { start: 0, end: 0, top: 0, bottom: 0 };
  const rowAt = (position: number) => {
    let low = 0, high = count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid + 1] <= position) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, count - 1);
  };
  const start = Math.max(0, rowAt(Math.max(0, offset)) - overscan);
  const end = Math.min(count, rowAt(Math.max(0, offset) + viewport) + 1 + overscan);
  return { start, end, top: offsets[start], bottom: offsets[count] - offsets[end] };
}
