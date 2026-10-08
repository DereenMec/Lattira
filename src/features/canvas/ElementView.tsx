import { ImageOff } from "lucide-react";
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/i18n";
import { fileIconUrl } from "@/lib/fileIcons";
import { fileExtension, formatBytes } from "@/lib/format";
import type { Asset, CanvasElement, ID } from "@/types/model";

export interface ElementHandlers {
  onPointerDown(e: ReactPointerEvent, id: ID): void;
  onResizeStart(e: ReactPointerEvent, id: ID): void;
  onConnectStart(e: ReactPointerEvent, id: ID): void;
  onDoubleClick(id: ID): void;
  onContextMenu(e: ReactMouseEvent, id: ID): void;
  onFinishEdit(id: ID, value: string): void;
}

interface Props {
  el: CanvasElement;
  selected: boolean;
  /** 只有单选时显示缩放与连线手柄 */
  showHandles: boolean;
  editing: boolean;
  highlighted: boolean;
  /** 命中画布内查找 */
  matched: boolean;
  /** 缩得很小时只画首行文字，减少排版开销 */
  lod: boolean;
  asset?: Asset;
  assetUrl?: string;
  handlers: ElementHandlers;
}

function ElementViewImpl({ el, selected, showHandles, editing, highlighted, matched, lod, asset, assetUrl, handlers }: Props) {
  const t = useT();
  const isSection = el.type === "section";
  const className = [
    "el",
    `el-${el.type}`,
    el.color && el.color !== "default" ? `color-${el.color}` : "",
    selected ? "is-selected" : "",
    editing ? "is-editing" : "",
    highlighted ? "is-highlighted" : "",
    matched ? "is-match" : "",
    lod ? "is-lod" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={{ transform: `translate(${el.x}px, ${el.y}px)`, width: el.width, height: el.height }}
      data-element-id={el.id}
      onPointerDown={isSection ? undefined : (e) => handlers.onPointerDown(e, el.id)}
      onDoubleClick={isSection ? undefined : () => handlers.onDoubleClick(el.id)}
      onContextMenu={isSection ? undefined : (e) => handlers.onContextMenu(e, el.id)}
    >
      {el.type === "text" &&
        (editing ? (
          <TextEditor initial={el.text} multiline onDone={(v) => handlers.onFinishEdit(el.id, v)} />
        ) : lod ? (
          <div className="el-text-lod">{firstLine(el.text)}</div>
        ) : (
          <div className="el-text-body">{el.text || <span className="placeholder">{t("空白卡片")}</span>}</div>
        ))}

      {el.type === "image" &&
        (assetUrl ? (
          <img className="el-image-body" src={assetUrl} alt={asset?.name ?? ""} draggable={false} decoding="async" />
        ) : (
          <div className="el-missing">
            <ImageOff size={20} />
            <span>{asset?.name ?? t("图片不可用")}</span>
          </div>
        ))}

      {el.type === "file" && (
        <div className="el-file-body">
          <img className="file-icon" src={fileIconUrl(asset?.name ?? "")} alt="" draggable={false} />
          <div className="file-meta">
            <div className="file-name" title={asset?.name}>
              {asset?.name ?? t("文件不可用")}
            </div>
            <div className="file-sub">
              {asset ? `${fileExtension(asset.name).toUpperCase() || t("文件")} · ${formatBytes(asset.size)}` : ""}
            </div>
          </div>
        </div>
      )}

      {el.type === "section" && (
        <div
          className="el-section-label"
          onPointerDown={(e) => handlers.onPointerDown(e, el.id)}
          onDoubleClick={() => handlers.onDoubleClick(el.id)}
          onContextMenu={(e) => handlers.onContextMenu(e, el.id)}
        >
          {editing ? (
            <TextEditor initial={el.label} onDone={(v) => handlers.onFinishEdit(el.id, v)} />
          ) : (
            el.label || t("未命名分组")
          )}
        </div>
      )}

      {showHandles && !editing && (
        <>
          <div className="handle-resize" onPointerDown={(e) => handlers.onResizeStart(e, el.id)} title={t("拖动调整大小")} />
          {!isSection && (
            <div className="handle-connect" onPointerDown={(e) => handlers.onConnectStart(e, el.id)} title={t("拖到另一张卡片上连线")} />
          )}
        </>
      )}
    </div>
  );
}

export const ElementView = memo(ElementViewImpl);

const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";

function TextEditor({ initial, multiline, onDone }: { initial: string; multiline?: boolean; onDone(value: string): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };

  const common = {
    ref,
    value,
    className: multiline ? "el-text-editor" : "el-label-editor",
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    onBlur: finish,
    onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
    onKeyDown: (e: ReactKeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (!multiline || e.ctrlKey))) {
        e.preventDefault();
        finish();
      }
    },
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}
