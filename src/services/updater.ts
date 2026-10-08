/**
 * 在线更新：从 GitHub Release 的 latest.json 检查新版本，下载安装包后自动安装并重启。
 * 发布方法见 docs/DEVELOPMENT.md「发布」；浏览器预览中不可用。
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { t } from "@/i18n";
import { isDesktop } from "./desktop";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; checkedAt: number }
  | { kind: "available"; version: string; date?: string; notes?: string }
  | { kind: "downloading"; version: string; received: number; total?: number }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

export const useUpdater = create<{ status: UpdateStatus }>(() => ({ status: { kind: "idle" } }));

let pending: Update | null = null;
const setStatus = (status: UpdateStatus) => useUpdater.setState({ status });

/** 检查更新。silent 为 true 时（启动时的自动检查）出错不显示 */
export async function checkForUpdates(silent = false): Promise<UpdateStatus> {
  if (!isDesktop) return useUpdater.getState().status;
  const busy = useUpdater.getState().status.kind;
  if (busy === "checking" || busy === "downloading" || busy === "installing") return useUpdater.getState().status;
  setStatus({ kind: "checking" });
  try {
    pending = await check({ timeout: 20000 });
    setStatus(
      pending
        ? { kind: "available", version: pending.version, date: pending.date, notes: pending.body }
        : { kind: "latest", checkedAt: Date.now() },
    );
  } catch (e) {
    setStatus(silent ? { kind: "idle" } : { kind: "error", message: t("检查更新失败：{error}", { error: String(e) }) });
  }
  return useUpdater.getState().status;
}

/** 下载并安装；beforeInstall 用来把未保存的修改写盘。安装完成后重启栖页 */
export async function installUpdate(beforeInstall: () => Promise<void>) {
  const update = pending;
  if (!update) return;
  const version = update.version;
  let received = 0;
  let total: number | undefined;
  try {
    await beforeInstall();
    setStatus({ kind: "downloading", version, received });
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        setStatus({ kind: "downloading", version, received, total });
      } else setStatus({ kind: "installing", version });
    });
    // Windows 上安装程序会自行关闭并重新打开栖页，其他情况手动重启
    await relaunch();
  } catch (e) {
    setStatus({ kind: "error", message: t("更新失败：{error}", { error: String(e) }) });
  }
}
