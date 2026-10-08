import { Clock } from "lucide-react";
import { useMemo } from "react";
import { addDays, toLocalDate } from "@/lib/date";
import { useAppStore } from "@/store/appStore";
import type { CanvasMeta } from "@/types/model";
import { CanvasCard } from "./CanvasCard";

/** 最近编辑过的画布，按时间降序，分组显示 */
export function RecentView() {
  const canvases = useAppStore((s) => s.canvases);

  const groups = useMemo(() => {
    const today = new Date();
    const todayKey = toLocalDate(today);
    const yesterdayKey = toLocalDate(addDays(today, -1));
    const weekAgo = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -6).getTime();
    const buckets: { label: string; items: CanvasMeta[] }[] = [
      { label: "今天", items: [] },
      { label: "昨天", items: [] },
      { label: "最近 7 天", items: [] },
      { label: "更早", items: [] },
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
        <h1>最近</h1>
        <span className="page-sub">{canvases.length} 个画布</span>
      </header>
      <p className="page-desc">所有项目里的画布，按最后编辑时间从近到远排列。</p>

      {groups.length === 0 ? (
        <div className="empty-block">
          <Clock size={28} />
          <p>还没有画布</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="recent-group">
            <h2>{g.label}</h2>
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
