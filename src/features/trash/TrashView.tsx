import { RotateCcw, Trash2, X } from "lucide-react";
import { modalOpen } from "@/lib/operations";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { CanvasThumb } from "@/features/project/CanvasThumb";
import { t, useT } from "@/i18n";
import { formatRelative } from "@/lib/date";
import { fileIconUrl } from "@/lib/fileIcons";
import { formatBytes } from "@/lib/format";
import { backend } from "@/services/backend";
import { confirmAction } from "@/services/confirm";
import { projectLabel, useAppStore } from "@/store/appStore";
import { reindexCanvas } from "@/store/canvasStore";
import type { TrashItem, TrashRef } from "@/types/model";

const keyOf = (i: TrashRef) => `${i.kind}:${i.id}`;
const refOf = (i: TrashItem): TrashRef => ({ kind: i.kind, id: i.id });
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input, textarea");

/** 回收站：删除的画布和文件，可以恢复或永久删除 */
export function TrashView() {
  useT();
  const projects = useAppStore((s) => s.projects);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const anchor = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await backend.listTrash();
      setItems(list);
      const alive = new Set(list.map(keyOf));
      setSelected((s) => new Set([...s].filter((k) => alive.has(k))));
    } catch (e) {
      setItems([]);
      useAppStore.getState().showToast(t("读取回收站失败：{error}", { error: String(e) }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 恢复后画布列表、资源库和引用计数都会变，统一重新读取 */
  const restore = useCallback(
    async (refs: TrashRef[]) => {
      if (refs.length === 0) return;
      const app = useAppStore.getState();
      setBusy(true);
      try {
        const res = await backend.restoreTrash(refs);
        app.addAssets(res.assets);
        for (const c of res.canvases) await reindexCanvas(c.id).catch(() => undefined);
        app.showToast(t("已恢复 {n} 项", { n: res.canvases.length + res.assets.length }));
      } catch (e) {
        app.showToast(t("恢复失败：{error}", { error: String(e) }));
      } finally {
        const [canvases] = await Promise.all([backend.listCanvases(), app.refreshAssets()]).catch(() => [app.canvases]);
        useAppStore.setState({ canvases });
        await reload();
        setBusy(false);
      }
    },
    [reload],
  );

  const purge = useCallback(
    async (refs: TrashRef[]) => {
      if (refs.length === 0 || !items) return;
      const name =
        refs.length === 1
          ? t("「{name}」", { name: items.find((i) => keyOf(i) === keyOf(refs[0]))?.name ?? "" })
          : t("这 {n} 项", { n: refs.length });
      if (!(await confirmAction(t("永久删除{name}？此操作无法撤销。", { name })))) return;
      setBusy(true);
      try {
        await backend.purgeTrash(refs);
      } catch (e) {
        useAppStore.getState().showToast(t("删除失败：{error}", { error: String(e) }));
      } finally {
        await reload();
        setBusy(false);
      }
    },
    [items, reload],
  );

  const emptyAll = async () => {
    if (!items?.length) return;
    if (!(await confirmAction(t("清空回收站？其中的 {n} 项将被永久删除，无法恢复。", { n: items.length })))) return;
    setBusy(true);
    try {
      await backend.emptyTrash();
      useAppStore.getState().showToast(t("回收站已清空"));
    } catch (e) {
      useAppStore.getState().showToast(t("清空回收站失败：{error}", { error: String(e) }));
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const list = items ?? [];
  const selectedRefs = list.filter((i) => selected.has(keyOf(i))).map(refOf);
  const total = list.reduce((sum, i) => sum + i.size, 0);

  /** 单击单选，Ctrl+单击增减，Shift+单击选连续一段 */
  const onRowClick = (e: ReactMouseEvent, index: number) => {
    e.stopPropagation();
    const key = keyOf(list[index]);
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      const range = list.slice(from, to + 1).map(keyOf);
      setSelected((s) => new Set(e.ctrlKey ? [...s, ...range] : range));
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      setSelected(new Set([key]));
    }
  };

  const showMenu = (e: ReactMouseEvent, index: number) => {
    const key = keyOf(list[index]);
    // 右键未选中的条目时只针对它，右键已选中的条目时针对全部选中项
    const refs = selected.has(key) ? selectedRefs : [refOf(list[index])];
    if (!selected.has(key)) setSelected(new Set([key]));
    openContextMenu(e, [
      { label: refs.length > 1 ? t("恢复 {n} 项", { n: refs.length }) : t("恢复"), icon: <RotateCcw size={15} />, onSelect: () => void restore(refs) },
      "separator",
      {
        label: refs.length > 1 ? t("永久删除 {n} 项", { n: refs.length }) : t("永久删除"),
        icon: <Trash2 size={15} />,
        hint: "Delete",
        danger: true,
        onSelect: () => void purge(refs),
      },
    ]);
  };

  // Ctrl+A 全选、Delete 永久删除、Esc 取消选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || modalOpen() || useAppStore.getState().searchOpen || isTyping(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(list.map(keyOf)));
      } else if (e.key === "Delete" && selectedRefs.length) {
        e.preventDefault();
        void purge(selectedRefs);
      } else if (e.key === "Escape") {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const origin = (item: TrashItem) => {
    if (item.kind === "asset") return t("资源库");
    const p = projects.find((x) => x.id === item.projectId);
    return p ? projectLabel(p) : "";
  };

  return (
    <div className="page trash-page" onClick={() => setSelected(new Set())}>
      <header className="page-head">
        <h1>{t("回收站")}</h1>
        <span className="page-sub">{items && t("{n} 项 · 共 {size}", { n: list.length, size: formatBytes(total) })}</span>
        <div className="page-actions">
          <button className="btn ghost" disabled={busy || list.length === 0} onClick={() => void emptyAll()}>
            <Trash2 size={14} /> {t("清空回收站")}
          </button>
        </div>
      </header>

      {selectedRefs.length > 0 ? (
        <div className="selection-bar" onClick={(e) => e.stopPropagation()}>
          <span>{t("已选 {n} 项", { n: selectedRefs.length })}</span>
          <button className="btn primary" disabled={busy} onClick={() => void restore(selectedRefs)}>
            <RotateCcw size={14} /> {t("恢复")}
          </button>
          <button className="btn danger" disabled={busy} onClick={() => void purge(selectedRefs)}>
            <Trash2 size={14} /> {t("永久删除")}
          </button>
          <button className="btn ghost" onClick={() => setSelected(new Set())}>
            {t("取消选择")}
          </button>
        </div>
      ) : (
        <p className="page-desc">
          {t("删除的画布和文件会先放在这里，可以恢复或永久删除。恢复的文件回到资源库，已从画布上移除的卡片不会自动放回。")}
        </p>
      )}

      {items && list.length === 0 ? (
        <div className="empty-block">
          <Trash2 size={28} />
          <p>{t("回收站是空的")}</p>
        </div>
      ) : (
        <div className="asset-table-wrap">
          <table className="asset-table trash-table">
            <thead>
              <tr>
                <th className="col-name">{t("名称")}</th>
                <th className="col-type">{t("类型")}</th>
                <th className="col-origin">{t("原位置")}</th>
                <th className="col-date">{t("删除时间")}</th>
                <th className="col-size">{t("大小")}</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((item, i) => (
                <tr
                  key={keyOf(item)}
                  className={selected.has(keyOf(item)) ? "is-selected" : ""}
                  onClick={(e) => onRowClick(e, i)}
                  onContextMenu={(e) => showMenu(e, i)}
                >
                  <td className="col-name">
                    {item.kind === "canvas" ? (
                      <span className="trash-thumb">
                        <CanvasThumb preview={item.preview} />
                      </span>
                    ) : (
                      <img src={fileIconUrl(item.name)} alt="" draggable={false} />
                    )}
                    <span title={item.name}>{item.name}</span>
                  </td>
                  <td className="col-type">
                    {item.kind === "canvas" ? t("画布 · {n} 个元素", { n: item.elementCount ?? 0 }) : t("文件")}
                  </td>
                  <td className="col-origin">{origin(item)}</td>
                  <td className="col-date" title={new Date(item.deletedAt).toLocaleString()}>
                    {formatRelative(item.deletedAt)}
                  </td>
                  <td className="col-size">{formatBytes(item.size)}</td>
                  <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" disabled={busy} onClick={() => void restore([refOf(item)])} title={t("恢复")}>
                      <RotateCcw size={15} />
                    </button>
                    <button className="icon-btn" disabled={busy} onClick={() => void purge([refOf(item)])} title={t("永久删除")}>
                      <X size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
