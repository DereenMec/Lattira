import { BoxSelect, ChevronRight, ClipboardPaste, FolderOpen, FolderPlus, Globe, Paperclip, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { openContextMenu } from "@/features/menu/ContextMenu";
import { folderItemMenu, renameFolder } from "@/features/menu/menus";
import { t as tr, useT } from "@/i18n";
import { canMoveInto, childrenOf, childCounts, folderChain, folderName, isFolder } from "@/lib/folders";
import type { Point } from "@/lib/geometry";
import { fileIconUrl } from "@/lib/fileIcons";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { Asset, CanvasElement, ID } from "@/types/model";
import { copySelection, cutSelection, duplicateCards, pasteIntoCanvas } from "./clipboard";
import { Highlight } from "@/features/search/Highlight";
import { useVirtualRows } from "@/lib/useVirtualRows";
import { AssetImage } from "@/features/assets/AssetImage";
import { FolderGlyph } from "./FolderGlyph";
import { hostOf, openLink, promptLink } from "./links";
import { moveIntoFolderNamed, moveToCanvasNamed, newFolderLabel } from "./cardNames";
import { newMenuEntry } from "./newFiles";
import { openFromCanvas } from "./assetEditing";
import { newFolder, newTextCard as makeTextCard } from "./placement";

const canvas = () => useCanvasStore.getState();
const app = () => useAppStore.getState();

/** 文件夹窗口有焦点时不交给画布处理的按键（不带 Ctrl / 带 Ctrl） */
const WINDOW_KEYS = new Set(["delete", "backspace", "enter", "f2", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
const WINDOW_MOD_KEYS = new Set(["a", "c", "x", "d", "g"]);

/** 拖动超过这个距离（像素）才算开始拖 */
const DRAG_THRESHOLD = 5;

/** 窗口的位置和大小：本次运行中记住，关掉再打开还在原处 */
let savedFrame: { left: number; top: number; width: number; height: number } | null = null;

/** 拖动窗口里的内容时，松手会落到哪里 */
type DropAt = { kind: "folder"; id: ID } | { kind: "canvas"; at: Point } | null;

interface ItemDrag {
  ids: ID[];
  x: number;
  y: number;
  label: string;
  /** 窗口里被指着的子文件夹或路径上的文件夹 */
  over: ID | null;
}

interface Props {
  folderId: ID;
  /** 要选中、定位并闪一下的元素（如搜索命中的、刚粘贴进来的）；n 变化时重新定位 */
  focusIds?: ID[];
  focusN: number;
  /** 画布上的卡片正被拖到窗口（folderId）或窗口里的某个子文件夹上 */
  dropTarget: ID | null;
  /**
   * 画布内查找（Ctrl+F）的结果：matches 是命中的元素，paths 还包括逐层包含它们的文件夹，
   * current 是当前跳到的那一项及包含它的文件夹。没有在查找时为 null
   */
  find: { query: string; matches: ReadonlySet<ID>; paths: ReadonlySet<ID>; current: ReadonlySet<ID> } | null;
  /** 屏幕坐标对应的画布坐标；不在画布可放置的区域上时为 null */
  canvasPointAt(clientX: number, clientY: number): Point | null;
  /** 屏幕坐标下画布上的文件夹卡片 */
  canvasFolderAt(clientX: number, clientY: number): ID | null;
  /** 高亮画布上的文件夹卡片，表示松手后放进它 */
  setCanvasDrop(id: ID | null): void;
  viewCenter(): Point;
  /** 从电脑选择文件（folders 为 true 时选择文件夹）放进这个文件夹 */
  insertFiles(folders: boolean): void;
}

/** 在列表里显示的名字 */
function itemName(el: CanvasElement, assets: ReadonlyMap<ID, Asset>, t: (s: string) => string): string {
  switch (el.type) {
    case "folder":
      return folderName(el, t("未命名文件夹"));
    case "text":
      return el.text.split("\n").find((l) => l.trim())?.trim() || t("空白卡片");
    case "link":
      return el.title || hostOf(el.url);
    default:
      return assets.get(el.assetId)?.name ?? t("文件不可用");
  }
}

/** 打开窗口里的一项：文件夹进入，文本卡片编辑，链接在浏览器打开，文件用默认程序打开 */
function openItem(el: CanvasElement) {
  if (el.type === "folder") canvas().openFolder(el.id);
  else if (el.type === "text") canvas().openEditor(el.id);
  else if (el.type === "link") void openLink(el.url);
  else {
    const asset = app().assets.get(el.assetId);
    if (!asset) app().showToast(tr("找不到这个文件"));
    else void openFromCanvas(asset, el.id);
  }
}

/**
 * 文件夹窗口：双击画布上的文件夹卡片打开，浮在画布上。
 * 里面的内容可以拖到画布上取出，画布上的卡片也可以拖进来；子文件夹双击进入，顶部路径可以返回上层。
 */
export function FolderPanel(props: Props) {
  const { folderId, focusIds, focusN, dropTarget, find } = props;
  const t = useT();
  const elements = useCanvasStore((s) => s.doc?.elements);
  const assets = useAppStore((s) => s.assets);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ID[]>([]);
  const anchor = useRef<ID | null>(null);
  const [flashIds, setFlashIds] = useState<ReadonlySet<ID>>(() => new Set());
  const [drag, setDrag] = useState<ItemDrag | null>(null);
  const [frame, setFrame] = useState(savedFrame);
  const propsRef = useRef(props);
  propsRef.current = props;

  const byId = useMemo(() => new Map((elements ?? []).map((e) => [e.id, e])), [elements]);
  const folder = byId.get(folderId);
  const items = useMemo(() => (elements ? childrenOf(elements, folderId) : []), [elements, folderId]);
  const counts = useMemo(() => childCounts(elements ?? []), [elements]);
  const chain = useMemo(() => folderChain(byId, folderId), [byId, folderId]);

  // 文件夹被删除（例如撤销了新建）时关掉窗口
  useEffect(() => {
    if (elements && folder?.type !== "folder") canvas().openFolder(null);
  }, [elements, folder]);

  // 换了文件夹：清空选择，回到顶部
  useEffect(() => {
    setSelected([]);
    anchor.current = null;
    gridRef.current?.scrollTo({ top: 0 });
  }, [folderId]);

  // 定位到要找的那几项：选中、滚动到可见处并闪一下
  useEffect(() => {
    if (!focusIds?.length) return;
    setSelected(focusIds);
    anchor.current = focusIds[0];
    setFlashIds(new Set(focusIds));
    // 粘贴进来的排在最后，滚到最后一个
    const last = focusIds[focusIds.length - 1];
    const grid = gridRef.current;
    if (grid) {
      const columns = Math.max(1, Math.floor((grid.clientWidth - 24 + 6) / 118));
      const index = items.findIndex((el) => el.id === last);
      if (index >= 0) grid.scrollTop = Math.floor(index / columns) * 146;
    }
    requestAnimationFrame(() =>
      gridRef.current?.querySelector(`[data-fp-item="${last}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    const timer = window.setTimeout(() => setFlashIds(new Set()), 1600);
    return () => window.clearTimeout(timer);
  }, [focusIds, focusN]);

  // 已经不在这个文件夹里的不再算选中
  const shownSelected = useMemo(() => {
    const here = new Set(items.map((e) => e.id));
    return selected.filter((id) => here.has(id));
  }, [selected, items]);

  if (!elements || folder?.type !== "folder") return null;

  const close = () => canvas().openFolder(null);
  const selectedSet = new Set(shownSelected);

  // ---- 窗口移动 ----
  const onHeaderPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const root = rootRef.current!;
    const parent = root.parentElement!.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const offset = { x: e.clientX - r.left, y: e.clientY - r.top };
    const move = (ev: PointerEvent) => {
      const left = Math.min(Math.max(0, ev.clientX - parent.left - offset.x), parent.width - 80);
      const top = Math.min(Math.max(0, ev.clientY - parent.top - offset.y), parent.height - 40);
      const next = { left, top, width: root.offsetWidth, height: root.offsetHeight };
      savedFrame = next;
      setFrame(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 用户拖动右下角改变大小后记住
  const rememberSize = () => {
    const root = rootRef.current;
    if (!root) return;
    const parent = root.parentElement!.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    savedFrame = { left: r.left - parent.left, top: r.top - parent.top, width: r.width, height: r.height };
  };

  // ---- 选择 ----
  const selectFor = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, id: ID): ID[] => {
    if (e.ctrlKey || e.metaKey) {
      anchor.current = id;
      return selectedSet.has(id) ? shownSelected.filter((x) => x !== id) : [...shownSelected, id];
    }
    if (e.shiftKey && anchor.current) {
      const order = items.map((x) => x.id);
      const a = order.indexOf(anchor.current);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) return order.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    anchor.current = id;
    return selectedSet.has(id) ? shownSelected : [id];
  };

  // ---- 拖动内容 ----
  const dropAt = (ids: ID[], x: number, y: number): DropAt => {
    const all = canvas().doc?.elements ?? [];
    const accept = (id: ID | null | undefined): DropAt =>
      id && id !== folderId && canMoveInto(all, ids, id) ? { kind: "folder", id } : null;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (hit && rootRef.current?.contains(hit)) {
      const target = hit.closest<HTMLElement>("[data-fp-folder], [data-fp-crumb]");
      return accept(target?.dataset.fpFolder ?? target?.dataset.fpCrumb);
    }
    const at = propsRef.current.canvasPointAt(x, y);
    if (!at) return null;
    const onto = propsRef.current.canvasFolderAt(x, y);
    if (onto) return accept(onto);
    return { kind: "canvas", at };
  };

  const onItemPointerDown = (e: ReactPointerEvent, el: CanvasElement) => {
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    if (e.button !== 0) return;
    const wasSelected = selectedSet.has(el.id);
    const next = selectFor(e, el.id);
    setSelected(next);
    if (!next.includes(el.id)) return;
    const ids = next;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let target: DropAt = null;
    const label = ids.length > 1 ? t("{n} 项", { n: ids.length }) : itemName(el, assets, t);

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
        started = true;
      }
      target = dropAt(ids, ev.clientX, ev.clientY);
      const overHere = target?.kind === "folder" && rootRef.current?.querySelector(`[data-fp-folder="${target.id}"], [data-fp-crumb="${target.id}"]`);
      setDrag({ ids, x: ev.clientX, y: ev.clientY, label, over: overHere && target?.kind === "folder" ? target.id : null });
      propsRef.current.setCanvasDrop(target?.kind === "folder" && !overHere ? target.id : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      propsRef.current.setCanvasDrop(null);
      if (!started) {
        // 单击已选中的多项之一：只留下它
        if (wasSelected && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) setSelected([el.id]);
        return;
      }
      if (ev.type === "pointercancel" || !target) return;
      // 与目标位置重名时要求改名
      if (target.kind === "canvas") void moveToCanvasNamed(ids, target.at).then(() => setSelected([]));
      else void moveIntoFolderNamed(ids, target.id).then((moved) => moved && setSelected([]));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const moveOut = (ids: ID[]) => void moveToCanvasNamed(ids, propsRef.current.viewCenter()).then(() => setSelected([]));

  const onItemMenu = (e: ReactMouseEvent, el: CanvasElement) => {
    e.stopPropagation();
    const ids = selectedSet.has(el.id) ? shownSelected : [el.id];
    setSelected(ids);
    openContextMenu(e, folderItemMenu(ids, { open: (id) => openItem(byId.get(id)!), moveOut: () => moveOut(ids) }));
  };

  const newSubfolder = () => {
    const f = newFolder({ x: 0, y: 0 }, folderId, newFolderLabel(folderId));
    canvas().addElements([f], { select: false });
    setSelected([f.id]);
    void renameFolder(f);
  };

  /** 粘贴进这个文件夹（右键菜单用；Ctrl+V 由画布的 paste 事件处理） */
  const pasteHere = () =>
    void pasteIntoCanvas(propsRef.current.viewCenter(), { files: [], text: "" }, folderId).then((ids) => {
      if (ids.length) canvas().openFolder(folderId, ids);
    });

  /** 在文件夹里新建文本卡片：窗口里不能原地编辑，直接打开编辑窗口；没写内容就关掉时卡片会被删掉 */
  const newTextCard = () => {
    const card = { ...makeTextCard(propsRef.current.viewCenter()), parentId: folderId };
    canvas().addElements([card], { select: false });
    setSelected([card.id]);
    canvas().openEditor(card.id);
  };

  const onGridMenu = (e: ReactMouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest(".fp-empty")) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected([]);
    // 与画布空白处的右键菜单一致，内容都放进这个文件夹
    const at = propsRef.current.viewCenter();
    openContextMenu(e, [
      newMenuEntry({ at, parentId: folderId, text: newTextCard, folder: newSubfolder, link: () => void promptLink(at, folderId) }),
      "separator",
      { label: t("在此插入文件…"), icon: <Paperclip size={15} />, onSelect: () => propsRef.current.insertFiles(false) },
      { label: t("从电脑导入文件夹…"), icon: <FolderOpen size={15} />, onSelect: () => propsRef.current.insertFiles(true) },
      { label: t("粘贴"), icon: <ClipboardPaste size={15} />, hint: "Ctrl+V", onSelect: pasteHere },
      "separator",
      {
        label: t("全选"),
        icon: <BoxSelect size={15} />,
        hint: "Ctrl+A",
        disabled: items.length === 0,
        onSelect: () => setSelected(items.map((x) => x.id)),
      },
    ]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const single = shownSelected.length === 1 ? byId.get(shownSelected[0]) : undefined;
    let handled = true;
    if (key === "delete" && shownSelected.length) canvas().deleteElements(shownSelected);
    else if (key === "backspace" && chain.length > 1) canvas().openFolder(chain[chain.length - 2].id);
    else if (key === "enter" && single) openItem(single);
    else if (key === "f2" && single && isFolder(single)) void renameFolder(single);
    else if (mod && key === "a") setSelected(items.map((x) => x.id));
    else if (mod && key === "c" && shownSelected.length) void copySelection(shownSelected);
    else if (mod && key === "x" && shownSelected.length) void cutSelection(shownSelected);
    else if (mod && key === "d" && shownSelected.length) void duplicateCards(shownSelected);
    else if (key === "escape") shownSelected.length ? setSelected([]) : close();
    else handled = false;
    // 窗口有焦点时，这些键只作用于窗口：窗口里没选中东西时也不能落到画布上，删掉或剪切画布上选中的卡片
    const windowOnly = mod ? WINDOW_MOD_KEYS.has(key) : WINDOW_KEYS.has(key);
    if (handled || windowOnly) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const virtualRows = useVirtualRows(gridRef, items.length, 146, 112, 6);
  const style = frame ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height, right: "auto" } : undefined;

  return (
    <div
      ref={rootRef}
      className={`folder-panel${dropTarget === folderId ? " is-drop-target" : ""}`}
      style={style}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.stopPropagation();
        rootRef.current?.focus({ preventScroll: true });
      }}
      onPointerUp={rememberSize}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <header className="fp-header" onPointerDown={onHeaderPointerDown}>
        <FolderGlyph size={20} />
        <nav className="fp-crumbs">
          {chain.map((f, i) => {
            const last = i === chain.length - 1;
            return (
              <span key={f.id} className="fp-crumb-wrap">
                {i > 0 && <ChevronRight size={14} className="fp-crumb-sep" />}
                <button
                  className={`fp-crumb${last ? " is-current" : ""}${drag?.over === f.id || (!last && dropTarget === f.id) ? " is-drop-target" : ""}`}
                  data-fp-crumb={last ? undefined : f.id}
                  onClick={() => !last && canvas().openFolder(f.id)}
                  onDoubleClick={() => last && void renameFolder(f)}
                  title={last ? t("双击重命名") : t("返回「{name}」", { name: folderName(f, t("未命名文件夹")) })}
                >
                  {folderName(f, t("未命名文件夹"))}
                </button>
              </span>
            );
          })}
        </nav>
        <button className="icon-btn" onClick={newSubfolder} title={t("新建子文件夹")}>
          <FolderPlus size={16} />
        </button>
        <button className="icon-btn" onClick={close} title={t("关闭（Esc）")}>
          <X size={16} />
        </button>
      </header>

      <div
        className="fp-grid"
        ref={gridRef}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && !e.ctrlKey && !e.shiftKey) setSelected([]);
        }}
        onContextMenu={onGridMenu}
      >
        {items.length === 0 ? (
          <div className="fp-empty">
            <FolderGlyph size={56} />
            <p>{t("文件夹是空的")}</p>
            <p className="hint">{t("把画布上的卡片拖到这里，就能放进这个文件夹")}</p>
          </div>
        ) : (
          <>
          {virtualRows.top > 0 && <div aria-hidden style={{ gridColumn: "1 / -1", height: virtualRows.top - 6 }} />}
          {items.slice(virtualRows.start, virtualRows.end).map((el) => (
            <div
              key={el.id}
              className={[
                "fp-item",
                selectedSet.has(el.id) ? "is-selected" : "",
                flashIds.has(el.id) ? "is-highlighted" : "",
                drag?.ids.includes(el.id) ? "is-dragging" : "",
                drag?.over === el.id || dropTarget === el.id ? "is-drop-target" : "",
                find?.paths.has(el.id) ? "is-match" : "",
                find?.current.has(el.id) ? "is-current-match" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-fp-item={el.id}
              data-fp-folder={el.type === "folder" ? el.id : undefined}
              title={itemName(el, assets, t)}
              onPointerDown={(e) => onItemPointerDown(e, el)}
              onDoubleClick={() => openItem(el)}
              onContextMenu={(e) => onItemMenu(e, el)}
            >
              <div className={`fp-thumb fp-thumb-${el.type}`}>
                <ItemThumb
                  el={el}
                  asset={"assetId" in el ? assets.get(el.assetId) : undefined}
                  query={find?.matches.has(el.id) ? find.query : undefined}
                />
              </div>
              <div className="fp-name">
                <Highlight text={itemName(el, assets, t)} query={find?.matches.has(el.id) ? find.query : undefined} />
              </div>
              {el.type === "folder" && (
                <div className="fp-sub">{counts.get(el.id) ? t("{n} 项", { n: counts.get(el.id)! }) : t("空文件夹")}</div>
              )}
            </div>
          ))}
          {virtualRows.bottom > 0 && <div aria-hidden style={{ gridColumn: "1 / -1", height: virtualRows.bottom - 6 }} />}
          </>
        )}
      </div>

      <footer className="fp-footer">
        <span>{shownSelected.length ? t("已选 {n} 项", { n: shownSelected.length }) : t("{n} 项", { n: items.length })}</span>
        <span className="fp-hint">{t("拖到画布上即可取出")}</span>
      </footer>

      {drag &&
        createPortal(
          <div className="fp-ghost" style={{ transform: `translate(${drag.x + 12}px, ${drag.y + 12}px)` }}>
            {drag.label}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ItemThumb({ el, asset, query }: { el: CanvasElement; asset?: Asset; query?: string }) {
  switch (el.type) {
    case "folder":
      return <FolderGlyph size={52} />;
    case "image": {
      const url = asset ? backend.assetUrl(asset) : "";
      return url && asset ? <AssetImage asset={asset} /> : <img className="fp-file-icon" src={fileIconUrl("")} alt="" draggable={false} />;
    }
    case "file":
      return <img className="fp-file-icon" src={fileIconUrl(asset?.name ?? "")} alt="" draggable={false} />;
    case "text":
      return (
        <div className="fp-text">
          <Highlight text={el.text} query={query} />
        </div>
      );
    case "link": {
      const icon = el.icon ? backend.workspaceFileUrl(el.icon) : "";
      return icon ? <img className="fp-link-icon" src={icon} alt="" draggable={false} /> : <Globe size={30} />;
    }
  }
}
