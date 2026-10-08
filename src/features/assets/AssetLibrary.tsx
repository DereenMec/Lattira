import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "@/lib/date";
import { fileExtension, formatBytes, isImageMime } from "@/lib/format";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import type { Asset } from "@/types/model";

type Filter = "all" | "image" | "document" | "unused";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "document", label: "文件" },
  { key: "unused", label: "未被引用" },
];

const matches = (a: Asset, f: Filter) =>
  f === "all" || (f === "image" ? isImageMime(a.mime) : f === "document" ? !isImageMime(a.mime) : a.refCount === 0);

export function AssetLibrary() {
  const assets = useAppStore((s) => s.assets);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void useAppStore.getState().refreshAssets();
  }, []);

  const all = useMemo(() => [...assets.values()].sort((a, b) => b.importedAt - a.importedAt), [assets]);
  const list = all.filter((a) => matches(a, filter));
  const total = all.reduce((sum, a) => sum + a.size, 0);

  return (
    <div className="page assets-page">
      <header className="page-head">
        <h1>资源库</h1>
        <span className="page-sub">
          {all.length} 个文件 · 共 {formatBytes(total)}
        </span>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "is-active" : ""} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </header>
      <p className="page-desc">拖进画布的文件都会复制一份存进工作区；同一个文件只存一份。</p>

      {list.length === 0 ? (
        <div className="empty-block">
          <p>{all.length === 0 ? "还没有导入过文件。把文件拖进任意画布即可。" : "没有符合条件的文件。"}</p>
        </div>
      ) : (
        <div className="asset-grid">
          {list.map((a) => (
            <button key={a.id} className="asset-card" onDoubleClick={() => void backend.openAsset(a)} title="双击用默认程序打开">
              <div className="asset-thumb">
                {isImageMime(a.mime) && backend.assetUrl(a) ? (
                  <img src={backend.assetUrl(a)} alt="" loading="lazy" draggable={false} />
                ) : (
                  <div className="file-badge large">{fileExtension(a.name).toUpperCase() || <FileText size={22} />}</div>
                )}
              </div>
              <div className="asset-name">{a.name}</div>
              <div className="asset-meta">
                {formatBytes(a.size)} · {formatRelative(a.importedAt)}
              </div>
              <div className={`asset-refs${a.refCount === 0 ? " is-unused" : ""}`}>
                {a.refCount === 0 ? "未被引用" : `${a.refCount} 个画布引用`}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
