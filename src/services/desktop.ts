/** 桌面端特有的能力（托盘、全局快捷键、退出），见 src-tauri/src/desktop.rs；浏览器预览中什么也不做 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "@/i18n";
import { backend } from "./backend";
import { useAppStore } from "@/store/appStore";

export const isDesktop = backend.kind === "tauri";

/** 设置呼出主界面的全局快捷键；null 表示不使用。注册失败（例如被其他程序占用）时抛出错误 */
export async function setGlobalShortcut(combo: string | null) {
  if (isDesktop) await invoke<void>("set_global_shortcut", { accelerator: combo });
}

export async function setCloseToTray(enabled: boolean) {
  if (isDesktop) await invoke<void>("set_close_to_tray", { enabled });
}

/** 窗口标题栏的深浅色；null 表示跟随系统 */
export async function setWindowTheme(theme: "light" | "dark" | null) {
  if (isDesktop) await getCurrentWindow().setTheme(theme);
}

/** 托盘菜单随界面语言更新 */
export async function syncTrayLabels() {
  if (isDesktop) {
    await invoke<void>("set_tray_labels", { show: t("显示栖页"), quit: t("退出"), tooltip: t("栖页 · Lattira") });
  }
}

/** 从托盘菜单退出时，先执行 beforeQuit（把未保存的修改写盘）再真正退出 */
export function handleQuit(beforeQuit: () => Promise<void>): () => void {
  if (!isDesktop) return () => {};
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen("quit-requested", async () => {
    try {
      await beforeQuit();
      await invoke<void>("exit_app");
    } catch (error) {
      await invoke<void>("cancel_quit");
      useAppStore.getState().showToast(t("保存失败：{error}", { error: String(error) }));
    }
  }).then((fn) => {
    if (cancelled) fn();
    else stop = fn;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}
