import type { LocalDate, Timestamp } from "@/types/model";

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalDate(d: Date): LocalDate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** 月视图的 6 周网格（周一为一周第一天） */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function formatTime(ts: Timestamp): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(ts: Timestamp, now = Date.now()): string {
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  const d = new Date(ts);
  const today = new Date(now);
  if (toLocalDate(d) === toLocalDate(today)) return `今天 ${formatTime(ts)}`;
  if (toLocalDate(d) === toLocalDate(addDays(today, -1))) return `昨天 ${formatTime(ts)}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${formatTime(ts)}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
