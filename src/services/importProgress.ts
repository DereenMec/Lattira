/**
 * 正在进行的导入及其进度。进度来自 Rust 端的 import-progress 事件（见 src-tauri/src/commands.rs），
 * 或由前端自己按文件数上报（粘贴的图片等内存数据）。界面见 features/layout/ImportProgress.tsx。
 */
import { create } from "zustand";

/** 与 src-tauri/src/commands.rs 的 ImportProgressEvent 对应 */
export interface ImportProgressEvent {
  task: string;
  current: string;
  doneFiles: number;
  totalFiles: number;
  /** 0～1 */
  fraction: number;
}

export interface ImportTask {
  id: string;
  /** 用于识别重复的导入（例如同一批路径） */
  key?: string;
  startedAt: number;
  current?: string;
  doneFiles: number;
  totalFiles: number;
  /** 还没收到进度时为 null（正在准备） */
  fraction: number | null;
}

export const useImports = create<{ tasks: ImportTask[] }>(() => ({ tasks: [] }));

let seq = 0;

export function beginImportTask(key?: string): ImportTask {
  const task: ImportTask = { id: `import-${Date.now()}-${++seq}`, key, startedAt: Date.now(), doneFiles: 0, totalFiles: 0, fraction: null };
  useImports.setState((s) => ({ tasks: [...s.tasks, task] }));
  return task;
}

export function endImportTask(id: string) {
  useImports.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
}

export function reportImportProgress(e: ImportProgressEvent) {
  useImports.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === e.task ? { ...t, current: e.current, doneFiles: e.doneFiles, totalFiles: e.totalFiles, fraction: e.fraction } : t,
    ),
  }));
}
