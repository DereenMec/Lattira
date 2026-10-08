import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { create } from "zustand";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  /** 右侧显示的快捷键提示 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?(): void;
  /** 子菜单 */
  children?: MenuEntry[];
  /** 自定义内容（如颜色色块），提供时忽略 label 以外的显示 */
  render?(close: () => void): ReactNode;
}

export type MenuEntry = MenuAction | "separator";

interface MenuState {
  menu: { x: number; y: number; items: MenuEntry[] } | null;
}

const useMenu = create<MenuState>(() => ({ menu: null }));

export function openContextMenu(e: ReactMouseEvent | MouseEvent, items: MenuEntry[]) {
  e.preventDefault();
  e.stopPropagation();
  const visible = items.filter((i, k) => i !== "separator" || (k > 0 && items[k - 1] !== "separator"));
  if (visible.length === 0) return;
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items: visible } });
}

export const closeContextMenu = () => useMenu.setState({ menu: null });

/** 在输入框以外屏蔽浏览器自带的右键菜单（后退、刷新、检查等对应用没有意义） */
export function useSuppressNativeMenu() {
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

function MenuList({ items, x, y, onClose }: { items: MenuEntry[]; x: number; y: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [open, setOpen] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<DOMRect | null>(null);

  // 靠近窗口边缘时向内翻转
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: x + r.width > window.innerWidth - 8 ? Math.max(8, x - r.width) : x,
      top: y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y,
    });
  }, [x, y]);

  const sub = open !== null ? items[open] : null;

  return (
    <>
      <div ref={ref} className="ctx-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="ctx-sep" />
          ) : item.render ? (
            <div key={i} className="ctx-custom">
              <span className="ctx-label">{item.label}</span>
              {item.render(onClose)}
            </div>
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`ctx-item${item.danger ? " is-danger" : ""}${open === i ? " is-open" : ""}`}
              disabled={item.disabled}
              onPointerEnter={(e) => {
                if (item.children) {
                  setOpen(i);
                  setSubAnchor(e.currentTarget.getBoundingClientRect());
                } else setOpen(null);
              }}
              onClick={() => {
                if (item.children) return;
                onClose();
                item.onSelect?.();
              }}
            >
              <span className="ctx-icon">{item.icon}</span>
              <span className="ctx-label">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
              {item.children && <ChevronRight size={14} className="ctx-arrow" />}
            </button>
          ),
        )}
      </div>
      {sub && sub !== "separator" && sub.children && subAnchor && (
        <MenuList items={sub.children} x={subAnchor.right - 4} y={subAnchor.top - 5} onClose={onClose} />
      )}
    </>
  );
}

/** 挂在应用根部，渲染当前打开的右键菜单 */
export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeContextMenu();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("wheel", closeContextMenu, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("wheel", closeContextMenu);
    };
  }, [menu]);

  if (!menu) return null;
  return <MenuList items={menu.items} x={menu.x} y={menu.y} onClose={closeContextMenu} />;
}
