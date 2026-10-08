import { ask } from "@tauri-apps/plugin-dialog";
import { backend } from "./backend";

/** 需要用户确认的操作（删除等）。桌面端用系统对话框，浏览器里用 window.confirm。 */
export async function confirmAction(message: string, title = "栖页"): Promise<boolean> {
  if (backend.kind === "tauri") return ask(message, { title, kind: "warning", okLabel: "确定", cancelLabel: "取消" });
  return window.confirm(message);
}
