/** 导入文件时的进度显示与重复导入检查，进度面板见 features/layout/ImportProgress.tsx */
import { t } from "@/i18n";
import { beginImportTask, endImportTask, useImports } from "@/services/importProgress";
import { useAppStore } from "@/store/appStore";

/** 导入超过这个时间（毫秒）才显示进度面板，结束时提示结果；更快的导入卡片直接出现，不打扰 */
export const SHOW_PROGRESS_AFTER = 400;

/** 同一批路径的标识：拖进来的顺序不同也算同一批 */
export const pathsKey = (paths: string[]) => [...paths].map((p) => p.toLowerCase()).sort().join("\n");

/**
 * 执行一次导入并显示进度。key 相同的导入还没完成时不再重复开始，提示后返回 null。
 * done 返回完成提示的文字；失败时抛出错误，由调用方提示。
 */
export async function runImport<T>(
  run: (task: string) => Promise<T>,
  opts: { key?: string; done?: (result: T) => string } = {},
): Promise<T | null> {
  const app = useAppStore.getState();
  const workspace = app.workspace?.path;
  if (opts.key && useImports.getState().tasks.some((task) => task.key === opts.key)) {
    app.showToast(t("这些文件正在导入，请稍候"));
    return null;
  }
  const task = beginImportTask(opts.key);
  try {
    const result = await run(task.id);
    if (opts.done && Date.now() - task.startedAt >= SHOW_PROGRESS_AFTER) app.showToast(opts.done(result));
    return result;
  } finally {
    if (workspace === useAppStore.getState().workspace?.path) await app.refreshAssets().catch(console.error);
    endImportTask(task.id);
  }
}

export const importedMessage = (n: number) => t("已导入 {n} 个文件", { n });
