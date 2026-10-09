/** 应用设置：主题、快捷键、关闭窗口时的行为、侧栏宽度。保存在 localStorage，不随工作区变化 */
import { create } from "zustand";
import { COMMANDS, comboFromEvent, type CommandId } from "@/lib/shortcuts";
import { setCloseToTray, setGlobalShortcut, setWindowTheme } from "@/services/desktop";

export type Theme = "system" | "light" | "dark";
export type Panel = "sidebar" | "inspector";

/** 侧栏宽度的默认值与可调范围（像素） */
export const PANEL_WIDTH: Record<Panel, { default: number; min: number; max: number }> = {
  sidebar: { default: 232, min: 180, max: 420 },
  inspector: { default: 260, min: 220, max: 560 },
};

interface Saved {
  theme: Theme;
  /** 启动时在后台检查更新 */
  autoCheckUpdates: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  /** 只记录改过的快捷键；null 表示清除了 */
  shortcuts: Partial<Record<CommandId, string | null>>;
  /** 关闭主窗口时最小化到托盘（否则退出） */
  closeToTray: boolean;
  /** 把链接放到画布上时访问网页，获取标题和预览图 */
  linkPreviews: boolean;
}

interface SettingsState extends Saved {
  /** 正在录入快捷键：此时不响应任何快捷键 */
  capturing: boolean;
  /** 修改快捷键；全局快捷键注册失败时抛出错误，设置保持不变 */
  setShortcut(id: CommandId, combo: string | null): Promise<void>;
  resetShortcuts(): Promise<void>;
  setCloseToTray(enabled: boolean): Promise<void>;
  setTheme(theme: Theme): void;
  setAutoCheckUpdates(enabled: boolean): void;
  setLinkPreviews(enabled: boolean): void;
  /** 拖动分隔条时实时调整；persist 为 true 时（松手）才写入存储 */
  setPanelWidth(panel: Panel, width: number, persist?: boolean): void;
}

const KEY = "lattira.settings";

const DEFAULTS: Saved = {
  shortcuts: {},
  closeToTray: true,
  theme: "system",
  autoCheckUpdates: true,
  linkPreviews: true,
  sidebarWidth: PANEL_WIDTH.sidebar.default,
  inspectorWidth: PANEL_WIDTH.inspector.default,
};

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Saved>) };
  } catch {
    // 读不到时用默认设置
  }
  return DEFAULTS;
}

const clamp = (panel: Panel, w: number) => Math.round(Math.min(PANEL_WIDTH[panel].max, Math.max(PANEL_WIDTH[panel].min, w)));

/** 跟随系统时不设 data-theme，由 CSS 的 prefers-color-scheme 决定；窗口标题栏一起切换 */
function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  void setWindowTheme(theme === "system" ? null : theme).catch(() => {});
}

export const useSettings = create<SettingsState>()((set, get) => {
  const persist = () => {
    const { shortcuts, closeToTray, theme, autoCheckUpdates, linkPreviews, sidebarWidth, inspectorWidth } = get();
    const saved: Saved = { shortcuts, closeToTray, theme, autoCheckUpdates, linkPreviews, sidebarWidth, inspectorWidth };
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // 存储不可用时只影响本次会话
    }
  };

  return {
    ...load(),
    capturing: false,

    async setShortcut(id, combo) {
      const def = COMMANDS.find((c) => c.id === id)!;
      if (def.global) await setGlobalShortcut(combo);
      const shortcuts = { ...get().shortcuts };
      if (combo === def.defaultKeys) delete shortcuts[id];
      else shortcuts[id] = combo;
      set({ shortcuts });
      persist();
    },

    async resetShortcuts() {
      const global = COMMANDS.find((c) => c.global)!;
      await setGlobalShortcut(global.defaultKeys);
      set({ shortcuts: {} });
      persist();
    },

    async setCloseToTray(enabled) {
      await setCloseToTray(enabled);
      set({ closeToTray: enabled });
      persist();
    },

    setTheme(theme) {
      applyTheme(theme);
      set({ theme });
      persist();
    },

    setAutoCheckUpdates(autoCheckUpdates) {
      set({ autoCheckUpdates });
      persist();
    },

    setLinkPreviews(linkPreviews) {
      set({ linkPreviews });
      persist();
    },

    setPanelWidth(panel, width, save = false) {
      set(panel === "sidebar" ? { sidebarWidth: clamp(panel, width) } : { inspectorWidth: clamp(panel, width) });
      if (save) persist();
    },
  };
});

applyTheme(useSettings.getState().theme);

/** 某个操作当前的快捷键 */
export function shortcutOf(id: CommandId, shortcuts = useSettings.getState().shortcuts): string | null {
  return id in shortcuts ? (shortcuts[id] ?? null) : COMMANDS.find((c) => c.id === id)!.defaultKeys;
}

/** 按键事件对应的应用内操作（不含全局快捷键） */
export function commandForEvent(e: KeyboardEvent): CommandId | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  return COMMANDS.find((c) => !c.global && shortcutOf(c.id) === combo)?.id ?? null;
}
