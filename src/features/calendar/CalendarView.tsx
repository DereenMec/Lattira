import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fullDate, monthDay, monthGrid, toLocalDate, yearMonth } from "@/lib/date";
import { msg, useT } from "@/i18n";
import { consumeDragClick, startCanvasDrag } from "@/features/layout/canvasDrag";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { ProjectIcon } from "@/features/project/projectIcons";
import { canvasMenu } from "@/features/menu/menus";
import { backend } from "@/services/backend";
import { projectLabel, useAppStore } from "@/store/appStore";
import type { CanvasDay, LocalDate } from "@/types/model";

const WEEKDAYS = [msg("一"), msg("二"), msg("三"), msg("四"), msg("五"), msg("六"), msg("日")];
const MAX_CHIPS = 3;

/** 工作日志式日历：画布出现在它被编辑过的每一天 */
export function CalendarView() {
  const t = useT();
  const canvases = useAppStore((s) => s.canvases);
  const projects = useAppStore((s) => s.projects);
  const navigate = useAppStore((s) => s.navigate);
  const today = toLocalDate(new Date());
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [days, setDays] = useState<CanvasDay[]>([]);
  const [selected, setSelected] = useState<LocalDate>(today);

  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const from = toLocalDate(grid[0]);
  const to = toLocalDate(grid[grid.length - 1]);

  // canvases 变化（保存、改名、删除）时重新拉取
  useEffect(() => {
    let alive = true;
    backend
      .calendarDays(from, to)
      .then((d) => alive && setDays(d))
      .catch((e) => useAppStore.getState().showToast(t("读取日历失败：{error}", { error: String(e) })));
    return () => {
      alive = false;
    };
  }, [from, to, canvases]);

  const canvasById = useMemo(() => new Map(canvases.map((c) => [c.id, c])), [canvases]);
  const colorOf = (projectId: string) => projects.find((p) => p.id === projectId)?.color ?? "var(--ink-3)";

  const byDate = useMemo(() => {
    const m = new Map<LocalDate, CanvasDay[]>();
    for (const d of days) {
      if (!canvasById.has(d.canvasId)) continue;
      const list = m.get(d.date) ?? [];
      list.push(d);
      m.set(d.date, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.changeCount - a.changeCount);
    return m;
  }, [days, canvasById]);

  const shift = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const goToday = () => {
    const d = new Date();
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(today);
  };

  const selectedList = byDate.get(selected) ?? [];
  const [sy, sm, sd] = selected.split("-").map(Number);

  return (
    <div className="page calendar-page">
      <header className="page-head">
        <h1>
          {yearMonth(cursor.year, cursor.month)}
        </h1>
        <div className="page-actions">
          <button className="icon-btn" onClick={() => shift(-1)} title={t("上个月")}>
            <ChevronLeft size={16} />
          </button>
          <button className="btn ghost" onClick={goToday}>
            {t("今天")}
          </button>
          <button className="icon-btn" onClick={() => shift(1)} title={t("下个月")}>
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <div className="calendar-body">
        <div className="month">
          {WEEKDAYS.map((w) => (
            <div key={w} className="weekday">
              {t(w)}
            </div>
          ))}
          {grid.map((date) => {
            const key = toLocalDate(date);
            const list = byDate.get(key) ?? [];
            const outside = date.getMonth() !== cursor.month;
            return (
              <button
                key={key}
                className={`day${outside ? " is-outside" : ""}${key === today ? " is-today" : ""}${key === selected ? " is-selected" : ""}`}
                onClick={() => setSelected(key)}
                onDoubleClick={() => list[0] && navigate({ kind: "canvas", canvasId: list[0].canvasId })}
              >
                <span className="day-num">{date.getDate()}</span>
                {list.slice(0, MAX_CHIPS).map((d) => {
                  const c = canvasById.get(d.canvasId)!;
                  return (
                    <span key={d.canvasId} className="day-chip" style={{ borderColor: colorOf(c.projectId) }}>
                      {c.title}
                    </span>
                  );
                })}
                {list.length > MAX_CHIPS && <span className="day-more">+{list.length - MAX_CHIPS}</span>}
              </button>
            );
          })}
        </div>

        <aside className="day-panel">
          <h2>
            {sy !== cursor.year ? fullDate(new Date(sy, sm - 1, sd)) : monthDay(new Date(sy, sm - 1, sd))}
          </h2>
          {selectedList.length === 0 ? (
            <p className="hint">{t("这一天没有编辑过画布。")}</p>
          ) : (
            <ul className="day-list">
              {selectedList.map((d) => {
                const c = canvasById.get(d.canvasId)!;
                const p = projects.find((x) => x.id === c.projectId);
                return (
                  <li key={d.canvasId}>
                    <button
                      onPointerDown={(e) => startCanvasDrag(e, c)}
                      onContextMenu={(e) => openContextMenu(e, canvasMenu(c))}
                      onClick={() => !consumeDragClick() && navigate({ kind: "canvas", canvasId: c.id })}
                    >
                      {p ? <ProjectIcon project={p} size={13} /> : <span />}
                      <span className="day-list-title">{c.title}</span>
                      <span className="day-list-meta">
                        {p ? projectLabel(p) : ""} · {t("{n} 处变化", { n: d.changeCount })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
