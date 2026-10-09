import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SHOW_PROGRESS_AFTER } from "@/features/canvas/importing";
import { useT } from "@/i18n";
import { useImports, type ImportTask } from "@/services/importProgress";

/** 右下角的导入进度：正在导入的文件、文件数和百分比 */
export function ImportProgressHost() {
  const tasks = useImports((s) => s.tasks);
  const [now, setNow] = useState(() => Date.now());
  const busy = tasks.length > 0;

  // 导入进行中定时刷新，较慢的导入到点后显示出来
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [busy]);

  const shown = tasks.filter((task) => now - task.startedAt >= SHOW_PROGRESS_AFTER);
  if (shown.length === 0) return null;
  return (
    <div className="import-progress" role="status" aria-live="polite">
      {shown.map((task) => (
        <ImportRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function ImportRow({ task }: { task: ImportTask }) {
  const t = useT();
  const percent = task.fraction === null ? null : Math.floor(task.fraction * 100);
  return (
    <div className="import-row">
      <div className="import-head">
        <Loader2 size={14} className="spin" />
        <span className="import-title">
          {task.totalFiles > 0
            ? t("正在导入 {done} / {total} 个文件", { done: Math.min(task.doneFiles + 1, task.totalFiles), total: task.totalFiles })
            : t("正在准备导入…")}
        </span>
        {percent !== null && <span className="import-percent">{percent}%</span>}
      </div>
      {task.current && (
        <div className="import-current" title={task.current}>
          {task.current}
        </div>
      )}
      <div className={`import-bar${percent === null ? " is-indeterminate" : ""}`}>
        <div style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  );
}
