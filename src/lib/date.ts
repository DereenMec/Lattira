import { currentLocale, t } from "@/i18n";
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

/** 月日，如「10月8日」/「Oct 8」 */
export function monthDay(d: Date): string {
  return currentLocale() === "en"
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 年月日，如「2026年10月8日」/「Oct 8, 2026」 */
export function fullDate(d: Date): string {
  return currentLocale() === "en"
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 年月，如「2026年10月」/「October 2026」 */
export function yearMonth(year: number, month: number): string {
  return currentLocale() === "en"
    ? new Date(year, month, 1).toLocaleDateString("en-US", { year: "numeric", month: "long" })
    : `${year}年${month + 1}月`;
}

export function formatRelative(ts: Timestamp, now = Date.now()): string {
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  if (diff < min) return t("刚刚");
  if (diff < hour) return t("{n} 分钟前", { n: Math.floor(diff / min) });
  const d = new Date(ts);
  const today = new Date(now);
  if (toLocalDate(d) === toLocalDate(today)) return t("今天 {time}", { time: formatTime(ts) });
  if (toLocalDate(d) === toLocalDate(addDays(today, -1))) return t("昨天 {time}", { time: formatTime(ts) });
  if (d.getFullYear() === today.getFullYear()) return `${monthDay(d)} ${formatTime(ts)}`;
  return fullDate(d);
}
