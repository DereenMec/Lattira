import { Globe, ImageOff } from "lucide-react";
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/i18n";
import { fileIconUrl } from "@/lib/fileIcons";
import { fileExtension, formatBytes } from "@/lib/format";
import { backend } from "@/services/backend";
import type { Asset, CanvasElement, ID, LinkElement } from "@/types/model";
import { Highlight } from "@/features/search/Highlight";
import { FolderGlyph } from "./FolderGlyph";
import { hostOf, useLinkFetching } from "./links";
import { registerEditor } from "@/lib/operations";
import { AssetImage } from "@/features/assets/AssetImage";

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
  /** 文件夹：拖动的卡片松手后会放进它 */
  dropTarget?: boolean;
  /** 文件夹里直接包含的元素数 */
  itemCount?: number;
  /** 命中画布内查找时的查询词，用来高亮卡片上的文字；没命中时为空，查询变化不会让其他卡片重新渲染 */
  findQuery?: string;
  /** 查找中当前跳到的那一个 */
  currentMatch?: boolean;
  /** 缩得很小时只画首行文字，减少排版开销 */
  lod: boolean;
  asset?: Asset;
  assetUrl?: string;
  handlers: ElementHandlers;
}

function ElementViewImpl({
  el,
  selected,
  showHandles,
  editing,
  highlighted,
  matched,
  dropTarget,
  itemCount = 0,
  findQuery,
  currentMatch,
  lod,
  asset,
  assetUrl,
  handlers,
}: Props) {
  const t = useT();
  const className = [
    "el",
    `el-${el.type}`,
    el.color && el.color !== "default" ? `color-${el.color}` : "",
    selected ? "is-selected" : "",
    editing ? "is-editing" : "",
    highlighted ? "is-highlighted" : "",
    matched ? "is-match" : "",
    currentMatch ? "is-current-match" : "",
    dropTarget ? "is-drop-target" : "",
    lod ? "is-lod" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={{ transform: `translate(${el.x}px, ${el.y}px)`, width: el.width, height: el.height, background: !el.color && el.sourceColor?.startsWith("#") ? el.sourceColor : undefined }}
      data-element-id={el.id}
      onPointerDown={(e) => handlers.onPointerDown(e, el.id)}
      onDoubleClick={() => handlers.onDoubleClick(el.id)}
      onContextMenu={(e) => handlers.onContextMenu(e, el.id)}
    >
      {el.type === "text" &&
        (editing ? (
          <TextEditor initial={el.text} multiline onDone={(v) => handlers.onFinishEdit(el.id, v)} />
        ) : lod ? (
          <div className="el-text-lod">
            <Highlight text={firstLine(el.text)} query={findQuery} />
          </div>
        ) : (
          <div className="el-text-body">
            {el.text ? <Highlight text={el.text} query={findQuery} /> : <span className="placeholder">{t("空白卡片")}</span>}
          </div>
        ))}

      {el.type === "image" &&
        (lod ? <div className="el-text-lod">{asset?.name ?? t("图片不可用")}</div> : assetUrl ? (
          asset ? <AssetImage className="el-image-body" asset={asset} alt={asset.name} /> : null
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
              {asset ? <Highlight text={asset.name} query={findQuery} /> : t("文件不可用")}
            </div>
            <div className="file-sub">
              {asset ? `${fileExtension(asset.name).toUpperCase() || t("文件")} · ${formatBytes(asset.size)}` : ""}
            </div>
          </div>
        </div>
      )}

      {el.type === "link" && <LinkBody el={el} lod={lod} query={findQuery} />}

      {el.type === "folder" && (
        <div className="el-folder-body">
          <FolderGlyph size={40} />
          <div className="file-meta">
            <div className="file-name" title={el.label}>
              {editing ? (
                <TextEditor initial={el.label} onDone={(v) => handlers.onFinishEdit(el.id, v)} />
              ) : el.label ? (
                <Highlight text={el.label} query={findQuery} />
              ) : (
                t("未命名文件夹")
              )}
            </div>
            <div className="file-sub">{itemCount ? t("{n} 项", { n: itemCount }) : t("空文件夹")}</div>
          </div>
        </div>
      )}

      {showHandles && !editing && (
        <>
          {/* 文件夹卡片大小固定 */}
          {el.type !== "folder" && (
            <div className="handle-resize" onPointerDown={(e) => handlers.onResizeStart(e, el.id)} title={t("拖动调整大小")} />
          )}
          <div className="handle-connect" onPointerDown={(e) => handlers.onConnectStart(e, el.id)} title={t("拖到另一张卡片上连线")} />
        </>
      )}
    </div>
  );
}

export const ElementView = memo(ElementViewImpl);

function LinkBody({ el, lod, query }: { el: LinkElement; lod: boolean; query?: string }) {
  const t = useT();
  const fetching = useLinkFetching((s) => s.ids.has(el.id));
  // 缓存的图片被删掉（例如导入的画布没有带上预览图）时不显示破图
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const fail = (src: string) => setFailed((f) => new Set(f).add(src));
  const host = hostOf(el.url);
  const title = el.title || host;
  if (lod)
    return (
      <div className="el-text-lod">
        <Highlight text={title} query={query} />
      </div>
    );
  const image = el.image ? backend.workspaceFileUrl(el.image) : "";
  const icon = el.icon ? backend.workspaceFileUrl(el.icon) : "";
  return (
    <div className="el-link-body" title={el.url}>
      {image && !failed.has(image) && (
        <img className="link-image" src={image} alt="" draggable={false} decoding="async" onError={() => fail(image)} />
      )}
      <div className="link-meta">
        <div className="link-title">
          <Highlight text={title} query={query} />
        </div>
        {el.description ? (
          <div className="link-desc">
            <Highlight text={el.description} query={query} />
          </div>
        ) : (
          !el.title && (
            <div className="link-desc link-url">
              <Highlight text={el.url} query={query} />
            </div>
          )
        )}
        {/* 没有获取到网页信息时标题已经是域名，不再重复 */}
        {(fetching || el.title) && (
          <div className="link-site">
            {icon && !failed.has(icon) ? (
              <img className="link-icon" src={icon} alt="" draggable={false} onError={() => fail(icon)} />
            ) : (
              <Globe size={13} className="link-icon" />
            )}
            <span>{fetching ? t("正在获取网页信息…") : el.siteName && el.siteName !== host ? `${el.siteName} · ${host}` : host}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";

function TextEditor({ initial, multiline, onDone }: { initial: string; multiline?: boolean; onDone(value: string): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(false);
  const draft = useRef(value);
  draft.current = value;
  useEffect(() => registerEditor(() => {
    if (!done.current) { done.current = true; onDone(draft.current); }
  }), [onDone]);

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
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Escape" || (e.key === "Enter" && (!multiline || e.ctrlKey))) {
        e.preventDefault();
        finish();
      }
    },
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}
