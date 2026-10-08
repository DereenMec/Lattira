import { ask } from "@tauri-apps/plugin-dialog";
import { t } from "@/i18n";
import { backend } from "./backend";

/** 需要用户确认的操作（删除等）。桌面端用系统对话框，浏览器里用 window.confirm。 */
export async function confirmAction(message: string, title = t("栖页")): Promise<boolean> {
  if (backend.kind === "tauri") return ask(message, { title, kind: "warning", okLabel: t("确定"), cancelLabel: t("取消") });
  return window.confirm(message);
}
