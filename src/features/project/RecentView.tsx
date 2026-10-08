import { Clock } from "lucide-react";
import { useMemo } from "react";
import { addDays, toLocalDate } from "@/lib/date";
import { msg, useT } from "@/i18n";
import { inboxOf, useAppStore } from "@/store/appStore";
import type { CanvasMeta } from "@/types/model";
import { CanvasCard } from "./CanvasCard";
import { CanvasListActions } from "./CanvasListActions";

/** 最近编辑过的画布，按时间降序，分组显示 */
export function RecentView() {
  const t = useT();
  const canvases = useAppStore((s) => s.canvases);
  const inbox = useAppStore((s) => inboxOf(s.projects));

  const groups = useMemo(() => {
    const today = new Date();
    const todayKey = toLocalDate(today);
    const yesterdayKey = toLocalDate(addDays(today, -1));
    const weekAgo = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -6).getTime();
    const buckets: { label: string; items: CanvasMeta[] }[] = [
      { label: msg("今天"), items: [] },
      { label: msg("昨天"), items: [] },
      { label: msg("最近 7 天"), items: [] },
      { label: msg("更早"), items: [] },
    ];
    for (const c of [...canvases].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const key = toLocalDate(new Date(c.updatedAt));
      const bucket = key === todayKey ? 0 : key === yesterdayKey ? 1 : c.updatedAt >= weekAgo ? 2 : 3;
      buckets[bucket].items.push(c);
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [canvases]);

  return (
    <div className="page project-page">
      <header className="page-head">
        <h1>{t("最近")}</h1>
        <span className="page-sub">{t("{n} 个画布", { n: canvases.length })}</span>
        <div className="page-actions">
          {/* 新建和导入的画布放进「未分类」，之后可以拖到某个项目 */}
          {inbox && <CanvasListActions projectId={inbox.id} intoInbox />}
        </div>
      </header>
      <p className="page-desc">{t("所有项目里的画布，按最后编辑时间从近到远排列。")}</p>

      {groups.length === 0 ? (
        <div className="empty-block">
          <Clock size={28} />
          <p>{t("还没有画布")}</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="recent-group">
            <h2>{t(g.label)}</h2>
            <div className="canvas-grid">
              {g.items.map((c) => (
                <CanvasCard key={c.id} canvas={c} showProject />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
