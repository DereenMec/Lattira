/**
 * 界面语言。中文原文本身就是翻译键：t("搜索") 在英文界面下查 en.ts，查不到时回退为中文。
 * 参数用 {name} 占位：t("已复制 {n} 张卡片", { n: 3 })。
 * `npm run i18n:check` 会扫描源码里的 t("…")，列出 en.ts 中缺少的翻译。
 */
import { create } from "zustand";
import { en } from "./en";

export type Locale = "zh" | "en";

const STORAGE_KEY = "lattira.locale";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // 读不到时按系统语言
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const useLocale = create<{ locale: Locale }>(() => ({ locale: initialLocale() }));

const applyLang = (l: Locale) => (document.documentElement.lang = l === "zh" ? "zh-CN" : "en");
applyLang(useLocale.getState().locale);

export function setLocale(locale: Locale) {
  useLocale.setState({ locale });
  applyLang(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 只影响下次启动时的默认语言
  }
}

export type Params = Record<string, string | number>;

export function t(text: string, params?: Params): string {
  let s = useLocale.getState().locale === "en" ? (en[text] ?? text) : text;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  return s;
}

/** 标记数据里的待翻译文本（原样返回），供 i18n:check 收集；显示时再用 t() 翻译 */
export const msg = (text: string) => text;

/** 组件里用这个：语言切换时组件会重新渲染 */
export function useT(): typeof t {
  useLocale((s) => s.locale);
  return t;
}

export const currentLocale = () => useLocale.getState().locale;
