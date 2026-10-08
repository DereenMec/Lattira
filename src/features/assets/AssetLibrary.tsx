import { ArrowDown, ArrowUp, LayoutGrid, List, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { openContextMenu, type MenuEntry } from "@/features/menu/ContextMenu";
import { assetEntries } from "@/features/menu/menus";
import { msg, t, useT } from "@/i18n";
import { formatRelative } from "@/lib/date";
import { fileIconUrl } from "@/lib/fileIcons";
import { fileExtension, formatBytes, isImageMime } from "@/lib/format";
import { backend } from "@/services/backend";
import { confirmAction } from "@/services/confirm";
import { useAppStore } from "@/store/appStore";
import { dropCanvasCache, useCanvasStore } from "@/store/canvasStore";
import type { Asset, ID } from "@/types/model";

type Filter = "all" | "image" | "document" | "unused";
type Layout = "grid" | "list";
type SortKey = "name" | "type" | "size" | "importedAt" | "refCount";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: msg("全部") },
  { key: "image", label: msg("图片") },
  { key: "document", label: msg("文件") },
  { key: "unused", label: msg("未被引用") },
];

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: msg("名称"), className: "col-name" },
  { key: "importedAt", label: msg("导入时间"), className: "col-date" },
  { key: "type", label: msg("类型"), className: "col-type" },
  { key: "size", label: msg("大小"), className: "col-size" },
  { key: "refCount", label: msg("引用"), className: "col-refs" },
];

const LAYOUT_KEY = "lattira.assets.layout";

const matchesFilter = (a: Asset, f: Filter) =>
  f === "all" || (f === "image" ? isImageMime(a.mime) : f === "document" ? !isImageMime(a.mime) : a.refCount === 0);

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** 搜索文件名、扩展名和图片中识别出的文字 */
const matchesQuery = (a: Asset, q: string) => !q || normalize(`${a.name}${a.ocrText ?? ""}`).includes(q);

const typeLabel = (a: Asset) => {
  const ext = fileExtension(a.name).toUpperCase();
  return isImageMime(a.mime) ? t("{ext} 图片", { ext }).trim() : ext ? t("{ext} 文件", { ext }) : t("文件");
};

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, textarea");

export function AssetLibrary() {
  useT();
  const assets = useAppStore((s) => s.assets);
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "importedAt", desc: true });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    void useAppStore.getState().refreshAssets();
  }, []);

  const changeLayout = (l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // 只影响下次打开时的默认视图
    }
  };

  const all = useMemo(() => [...assets.values()], [assets]);
  const list = useMemo(() => {
    const q = normalize(query);
    const rows = all.filter((a) => matchesFilter(a, filter) && matchesQuery(a, q));
    const value = (a: Asset): string | number =>
      sort.key === "name" ? a.name : sort.key === "type" ? typeLabel(a) : a[sort.key];
    rows.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = typeof x === "string" ? x.localeCompare(y as string, "zh-CN") : x - (y as number);
      return sort.desc ? -c : c;
    });
    return rows;
  }, [all, filter, sort, query]);
  const total = all.reduce((sum, a) => sum + a.size, 0);

  // 已经不在列表里的（被删除或被筛掉）不再算选中
  useEffect(() => {
    setSelected((s) => {
      const visible = new Set(list.map((a) => a.id));
      const next = new Set([...s].filter((id) => visible.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [list]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" && key !== "type" }));

  /** 单击单选，Ctrl+单击增减，Shift+单击选连续一段 */
  const onItemClick = (e: ReactMouseEvent, index: number) => {
    e.stopPropagation();
    const id = list[index].id;
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      const range = list.slice(from, to + 1).map((a) => a.id);
      setSelected((s) => new Set(e.ctrlKey ? [...s, ...range] : range));
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSelected(new Set([id]));
    }
  };

  const deleteAssets = useCallback(async (ids: ID[]) => {
    const app = useAppStore.getState();
    const targets = ids.map((id) => app.assets.get(id)).filter((a): a is Asset => !!a);
    if (targets.length === 0) return;
    const referenced = targets.filter((a) => a.refCount > 0).length;
    const name = targets.length === 1 ? t("「{name}」", { name: targets[0].name }) : t("这 {n} 个文件", { n: targets.length });
    const note = referenced
      ? t("其中 {n} 个文件被画布引用，对应的卡片也会从画布上移除。", { n: referenced })
      : t("这些文件没有被任何画布引用。");
    if (!(await confirmAction(t("删除{name}？\n{note}\n文件会移到回收站，之后可以恢复。", { name, note })))) return;
    try {
      // 先把正在编辑的画布写盘，删除后再重新读取，避免旧内容覆盖
      const canvas = useCanvasStore.getState();
      await canvas.flush();
      const res = await backend.deleteAssets(targets.map((a) => a.id));
      dropCanvasCache(res.canvasIds);
      const [fresh, canvases] = await Promise.all([backend.listAssets(), backend.listCanvases()]);
      useAppStore.setState({ assets: new Map(fresh.map((a) => [a.id, a])), canvases });
      if (canvas.doc && res.canvasIds.includes(canvas.doc.canvasId)) await canvas.load(canvas.doc.canvasId);
      setSelected(new Set());
      app.showToast(
        res.removedCards
          ? t("已删除 {n} 个文件，并从 {c} 个画布移除了 {k} 张卡片", { n: targets.length, c: res.canvasIds.length, k: res.removedCards })
          : t("已删除 {n} 个文件", { n: targets.length }),
      );
    } catch (e) {
      app.showToast(t("删除失败：{error}", { error: String(e) }));
    }
  }, []);

  const showMenu = (e: ReactMouseEvent, index: number) => {
    const asset = list[index];
    let ids = [...selected];
    if (!selected.has(asset.id)) {
      ids = [asset.id];
      setSelected(new Set(ids));
      anchor.current = index;
    }
    const remove: MenuEntry = {
      label: ids.length > 1 ? t("删除 {n} 个文件", { n: ids.length }) : t("删除"),
      icon: <Trash2 size={15} />,
      hint: "Delete",
      danger: true,
      onSelect: () => void deleteAssets(ids),
    };
    openContextMenu(e, ids.length > 1 ? [remove] : [...assetEntries(asset), "separator", remove]);
  };

  // 资源库页面的快捷键：Ctrl+A 全选、Delete 删除、Esc 取消选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useAppStore.getState().searchOpen || isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(list.map((a) => a.id)));
      } else if (e.key === "Delete" && selected.size > 0) {
        e.preventDefault();
        void deleteAssets([...selected]);
      } else if (e.key === "Escape") {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected, deleteAssets]);

  const selectedSize = list.filter((a) => selected.has(a.id)).reduce((sum, a) => sum + a.size, 0);

  return (
    <div className="page assets-page" onClick={() => setSelected(new Set())}>
      <header className="page-head">
        <h1>{t("资源库")}</h1>
        <span className="page-sub">
          {t("{n} 个文件 · 共 {size}", { n: all.length, size: formatBytes(total) })}
        </span>
        <label className="asset-search" onClick={(e) => e.stopPropagation()}>
          <Search size={15} />
          <input
            data-asset-search
            value={query}
            placeholder={t("搜索文件名或图片中的文字")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery("")} title={t("清除")}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="segmented" onClick={(e) => e.stopPropagation()}>
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "is-active" : ""} onClick={() => setFilter(f.key)}>
              {t(f.label)}
            </button>
          ))}
        </div>
        <div className="segmented icon-only" onClick={(e) => e.stopPropagation()}>
          <button className={layout === "grid" ? "is-active" : ""} onClick={() => changeLayout("grid")} title={t("卡片")}>
            <LayoutGrid size={15} />
          </button>
          <button className={layout === "list" ? "is-active" : ""} onClick={() => changeLayout("list")} title={t("详细信息")}>
            <List size={15} />
          </button>
        </div>
      </header>

      {selected.size > 0 ? (
        <div className="selection-bar" onClick={(e) => e.stopPropagation()}>
          <span>
            {t("已选 {n} 个文件 · {size}", { n: selected.size, size: formatBytes(selectedSize) })}
          </span>
          <button className="btn danger" onClick={() => void deleteAssets([...selected])}>
            <Trash2 size={14} /> {t("删除")}
          </button>
          <button className="btn ghost" onClick={() => setSelected(new Set())}>
            {t("取消选择")}
          </button>
        </div>
      ) : (
        <p className="page-desc">
          {t("拖进画布的文件都会复制一份存进工作区；同一个文件只存一份。Ctrl / Shift + 单击可多选，双击打开，右键查看更多操作。")}
        </p>
      )}

      {list.length === 0 ? (
        <div className="empty-block">
          <p>
            {all.length === 0
              ? t("还没有导入过文件。把文件拖进任意画布即可。")
              : query
                ? t("没有找到「{q}」", { q: query })
                : t("没有符合条件的文件。")}
          </p>
        </div>
      ) : layout === "grid" ? (
        <div className="asset-grid">
          {list.map((a, i) => (
            <button
              key={a.id}
              className={`asset-card${selected.has(a.id) ? " is-selected" : ""}`}
              onClick={(e) => onItemClick(e, i)}
              onDoubleClick={() => void backend.openAsset(a)}
              onContextMenu={(e) => showMenu(e, i)}
              title={a.name}
            >
              <div className="asset-thumb">
                {isImageMime(a.mime) && backend.assetUrl(a) ? (
                  <img src={backend.assetUrl(a)} alt="" loading="lazy" draggable={false} />
                ) : (
                  <img className="asset-type-icon" src={fileIconUrl(a.name)} alt="" draggable={false} />
                )}
              </div>
              <div className="asset-name">{a.name}</div>
              <div className="asset-meta">
                {formatBytes(a.size)} · {formatRelative(a.importedAt)}
              </div>
              <div className={`asset-refs${a.refCount === 0 ? " is-unused" : ""}`}>
                {a.refCount === 0 ? t("未被引用") : t("{n} 个画布引用", { n: a.refCount })}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="asset-table-wrap">
          <table className="asset-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.className} onClick={() => toggleSort(c.key)}>
                    <span>{t(c.label)}</span>
                    {sort.key === c.key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                <tr
                  key={a.id}
                  className={selected.has(a.id) ? "is-selected" : ""}
                  onClick={(e) => onItemClick(e, i)}
                  onDoubleClick={() => void backend.openAsset(a)}
                  onContextMenu={(e) => showMenu(e, i)}
                >
                  <td className="col-name">
                    <img src={fileIconUrl(a.name)} alt="" draggable={false} />
                    <span title={a.name}>{a.name}</span>
                  </td>
                  <td className="col-date">{new Date(a.importedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td className="col-type">{typeLabel(a)}</td>
                  <td className="col-size">{formatBytes(a.size)}</td>
                  <td className={`col-refs${a.refCount === 0 ? " is-unused" : ""}`}>
                    {a.refCount === 0 ? t("未被引用") : a.refCount}
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
