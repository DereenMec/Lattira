import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * 双击文本卡片后打开的大编辑窗口。卡片上直接编辑只适合短句，长文在这里写。
 * 关闭时保存；Esc 或 Ctrl+Enter 关闭。
 */
export function TextEditorDialog() {
  const t = useT();
  const editorId = useCanvasStore((s) => s.editorId);
  const el = useCanvasStore((s) => s.doc?.elements.find((e) => e.id === s.editorId));
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const initial = useRef("");

  useEffect(() => {
    if (!editorId || el?.type !== "text") return;
    initial.current = el.text;
    setValue(el.text);
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
      t.scrollTop = t.scrollHeight;
    });
    // 只在打开时读取一次卡片内容，编辑期间卡片不会被别处修改
  }, [editorId]);

  if (!editorId || el?.type !== "text") return null;

  const close = () => {
    const s = useCanvasStore.getState();
    s.closeEditor();
    // 文件夹里新建的卡片没写内容就关掉：不留空白卡片（画布上的卡片在原地编辑时也是这样）
    if (el.parentId && !value.trim() && !initial.current.trim()) s.deleteElements([editorId]);
    else if (value !== initial.current) s.updateElements({ [editorId]: { text: value } });
  };

  const lines = value.split("\n").length;
  const title = value.split("\n").find((l) => l.trim())?.trim() || t("无标题");

  return (
    <div className="overlay editor-overlay" onPointerDown={close}>
      <div className="dialog text-editor" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <span className="text-editor-title">{title}</span>
          <span className="text-editor-meta">
            {t("{chars} 字 · {lines} 行", { chars: value.length, lines })}
          </span>
          <button className="icon-btn" onClick={close} title={t("完成（Esc）")}>
            <X size={16} />
          </button>
        </header>
        <textarea
          ref={ref}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              close();
            }
          }}
        />
        <footer>{t("第一行会作为卡片标题加粗显示 · Esc 或 Ctrl+Enter 完成")}</footer>
      </div>
    </div>
  );
}
