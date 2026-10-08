import { Copy, FolderOpen, X } from "lucide-react";
import { useMemo } from "react";
import { create } from "zustand";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { CHANGELOG } from "./changelog";

const useAbout = create<{ open: boolean }>(() => ({ open: false }));
export const openAbout = () => useAbout.setState({ open: true });

/** 关于：版本、当前工作区、更新内容、作者 */
export function AboutDialog() {
  const open = useAbout((s) => s.open);
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const projects = useAppStore((s) => s.projects);
  const canvases = useAppStore((s) => s.canvases);
  const assets = useAppStore((s) => s.assets);
  const fileSize = useMemo(() => [...assets.values()].reduce((sum, a) => sum + a.size, 0), [assets]);

  if (!open) return null;
  const close = () => useAbout.setState({ open: false });
  const app = useAppStore.getState();

  const copyPath = async () => {
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(workspace.path);
      app.showToast(t("已复制工作区路径"));
    } catch (e) {
      app.showToast(t("复制失败：{error}", { error: String(e) }));
    }
  };

  return (
    <div className="overlay" onPointerDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dialog about-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn about-close" onClick={close} title={t("关闭")}>
          <X size={16} />
        </button>
        <header className="about-head">
          <img src="/lattira.svg" alt="" width={44} height={44} />
          <div>
            <h2>{t("栖页 · Lattira")}</h2>
            <div className="about-version">
              {t("版本")} {__APP_VERSION__}
            </div>
          </div>
        </header>
        <p className="about-tagline">{t("用画布整理文本、文件与图片，按项目归档，按日期回溯。")}</p>

        {workspace && (
          <section className="about-section">
            <h3>{t("当前工作区")}</h3>
            <dl className="props about-props">
              <dt>{t("名称")}</dt>
              <dd>{workspace.name}</dd>
              <dt>{t("位置")}</dt>
              <dd className="break mono">{workspace.path}</dd>
              <dt>{t("内容")}</dt>
              <dd>
                {t("{p} 个项目 · {c} 个画布 · {f} 个文件（{size}）", {
                  p: projects.filter((p) => !p.archived).length,
                  c: canvases.length,
                  f: assets.size,
                  size: formatBytes(fileSize),
                })}
              </dd>
            </dl>
            <div className="about-actions">
              {backend.kind === "tauri" && (
                <button className="btn" onClick={() => void backend.revealWorkspace().catch((e) => app.showToast(String(e)))}>
                  <FolderOpen size={14} /> {t("打开文件夹")}
                </button>
              )}
              <button className="btn" onClick={() => void copyPath()}>
                <Copy size={14} /> {t("复制路径")}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  close();
                  void app.pickWorkspace();
                }}
              >
                {t("切换工作区")}
              </button>
            </div>
          </section>
        )}

        <section className="about-section">
          <h3>{t("更新内容")}</h3>
          <div className="changelog">
            {CHANGELOG.map((r) => (
              <div key={r.version} className="release">
                <div className="release-head">
                  <span className="release-version">v{r.version}</span>
                  <span className="release-date">{r.date}</span>
                </div>
                <ul>
                  {r.items.map((item) => (
                    <li key={item}>{t(item)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <footer className="about-author">By z00613494</footer>
      </div>
    </div>
  );
}
