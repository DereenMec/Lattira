/**
 * 快捷键：用「修饰键 + KeyboardEvent.code」表示，例如 Ctrl+Shift+KeyL。
 * 用 code 而不是 key，按住 Shift 时 , 不会变成 <；这种写法也正好是 Rust 端全局快捷键能解析的格式。
 */
import { msg } from "@/i18n";

export type CommandId =
  | "showWindow"
  | "search"
  | "newCanvas"
  | "recent"
  | "inbox"
  | "calendar"
  | "assets"
  | "trash"
  | "openProject"
  | "settings"
  | "closeTab"
  | "nextTab"
  | "prevTab";

export interface CommandDef {
  id: CommandId;
  label: string;
  defaultKeys: string | null;
  /** 系统级快捷键：栖页在后台或托盘中时也能触发 */
  global?: boolean;
}

export const COMMANDS: CommandDef[] = [
  { id: "showWindow", label: msg("呼出主界面"), defaultKeys: "Ctrl+Shift+KeyL", global: true },
  { id: "search", label: msg("全局搜索"), defaultKeys: "Ctrl+KeyE" },
  { id: "newCanvas", label: msg("新建画布"), defaultKeys: "Ctrl+KeyN" },
  // Ctrl+1～4 与侧栏从上到下的顺序一致
  { id: "recent", label: msg("最近"), defaultKeys: "Ctrl+Digit1" },
  { id: "inbox", label: msg("未分类"), defaultKeys: "Ctrl+Digit2" },
  { id: "calendar", label: msg("日历"), defaultKeys: "Ctrl+Digit3" },
  { id: "assets", label: msg("资源库"), defaultKeys: "Ctrl+Digit4" },
  { id: "trash", label: msg("回收站"), defaultKeys: null },
  { id: "openProject", label: msg("打开当前画布所在的项目"), defaultKeys: null },
  { id: "settings", label: msg("设置"), defaultKeys: "Ctrl+Comma" },
  { id: "closeTab", label: msg("关闭标签页"), defaultKeys: "Ctrl+KeyW" },
  { id: "nextTab", label: msg("下一个标签页"), defaultKeys: "Ctrl+Tab" },
  { id: "prevTab", label: msg("上一个标签页"), defaultKeys: "Ctrl+Shift+Tab" },
];

/** 画布内的快捷键（固定，不可修改），设置页中列出供查阅；自定义时也不能与它们冲突 */
export const CANVAS_KEYS: { keys: string[]; label: string }[] = [
  { keys: ["KeyT"], label: msg("新建文本卡片") },
  { keys: ["Ctrl+KeyF"], label: msg("画布内查找") },
  { keys: ["Ctrl+KeyC", "Ctrl+KeyX", "Ctrl+KeyV"], label: msg("复制 / 剪切 / 粘贴卡片（窗口打开时可粘贴进文件夹）") },
  { keys: ["Ctrl+KeyD"], label: msg("创建副本") },
  { keys: ["Ctrl+KeyG"], label: msg("放进文件夹") },
  { keys: ["Ctrl+KeyA"], label: msg("全选") },
  { keys: ["Ctrl+KeyZ"], label: msg("撤销") },
  { keys: ["Ctrl+KeyY", "Ctrl+Shift+KeyZ"], label: msg("重做") },
  { keys: ["Delete"], label: msg("删除选中的卡片") },
  { keys: ["Enter"], label: msg("编辑选中的卡片（链接：在浏览器中打开；文件夹：打开）") },
  { keys: ["F2"], label: msg("重命名选中的文件夹") },
  { keys: ["ArrowUp", "Shift+ArrowUp"], label: msg("方向键移动选中的卡片 1 / 10 像素") },
  { keys: ["Alt"], label: msg("拖动时按住，暂时不吸附对齐") },
  { keys: ["Ctrl+Equal", "Ctrl+Minus"], label: msg("放大 / 缩小") },
  { keys: ["Ctrl+Digit0"], label: msg("缩放到 100%") },
  { keys: ["Shift+Digit1"], label: msg("显示全部内容") },
  { keys: ["Space"], label: msg("按住拖动画布") },
];

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

/** 按键事件对应的快捷键；只按了修饰键时返回 null */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

/** 可以设为快捷键：带 Ctrl 或 Alt，或者是单独的功能键（F1–F24） */
export function isAssignable(combo: string): boolean {
  const parts = combo.split("+");
  const code = parts[parts.length - 1];
  return parts.includes("Ctrl") || parts.includes("Alt") || /^F\d{1,2}$/.test(code);
}

const KEY_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Delete: "Delete",
};

/** 显示用：Ctrl+Shift+KeyL → Ctrl+Shift+L */
export function displayCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => KEY_LABELS[p] ?? p.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num "))
    .join("+");
}
