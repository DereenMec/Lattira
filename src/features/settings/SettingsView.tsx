import { Copy, Download, FolderOpen, FolderSync, Info, Keyboard, RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { msg, setLocale, t, useLocale, useT } from "@/i18n";
import { formatRelative } from "@/lib/date";
import { formatBytes } from "@/lib/format";
import { CANVAS_KEYS, COMMANDS, comboFromEvent, displayCombo, isAssignable, type CommandDef } from "@/lib/shortcuts";
import { backend } from "@/services/backend";
import { isDesktop } from "@/services/desktop";
import { checkForUpdates, installUpdate, useUpdater } from "@/services/updater";
import { useAppStore, type SettingsSection } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { shortcutOf, useSettings, type Theme } from "@/store/settingsStore";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: msg("通用"), icon: <SlidersHorizontal size={16} /> },
  { id: "workspace", label: msg("工作区"), icon: <FolderSync size={16} /> },
  { id: "shortcuts", label: msg("快捷键"), icon: <Keyboard size={16} /> },
  { id: "about", label: msg("关于"), icon: <Info size={16} /> },
];

/** 设置项的一行：左边说明，右边控件 */
function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? "is-active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GeneralSection() {
  const locale = useLocale((s) => s.locale);
  const theme = useSettings((s) => s.theme);
  const closeToTray = useSettings((s) => s.closeToTray);
  const setClose = (enabled: boolean) =>
    void useSettings
      .getState()
      .setCloseToTray(enabled)
      .catch((e) => useAppStore.getState().showToast(t("修改失败：{error}", { error: String(e) })));

  return (
    <>
      <h2>{t("通用")}</h2>
      <Row title={t("外观")}>
        <Segmented<Theme>
          value={theme}
          options={[
            { value: "system", label: t("跟随系统") },
            { value: "light", label: t("浅色") },
            { value: "dark", label: t("深色") },
          ]}
          onChange={(v) => useSettings.getState().setTheme(v)}
        />
      </Row>
      <Row title={t("界面语言")}>
        <Segmented
          value={locale}
          options={[
            { value: "zh", label: "中文" },
            { value: "en", label: "English" },
          ]}
          onChange={setLocale}
        />
      </Row>
      <Row
        title={t("关闭主窗口时")}
        desc={isDesktop ? t("最小化到托盘后，单击托盘图标或按呼出主界面的快捷键即可回来；右键托盘图标可以退出。") : t("仅桌面端可用。")}
      >
        <Segmented
          value={closeToTray ? "tray" : "quit"}
          options={[
            { value: "tray", label: t("最小化到托盘") },
            { value: "quit", label: t("退出栖页") },
          ]}
          onChange={(v) => setClose(v === "tray")}
        />
      </Row>
    </>
  );
}

function WorkspaceSection() {
  const workspace = useAppStore((s) => s.workspace);
  const projects = useAppStore((s) => s.projects);
  const canvases = useAppStore((s) => s.canvases);
  const assets = useAppStore((s) => s.assets);
  const fileSize = useMemo(() => [...assets.values()].reduce((sum, a) => sum + a.size, 0), [assets]);
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
    <>
      <h2>{t("工作区")}</h2>
      <p className="settings-desc">{t("工作区是电脑上的一个普通文件夹，画布、导入的文件和索引都保存在里面。")}</p>
      {workspace && (
        <dl className="props settings-props">
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
      )}
      <div className="settings-actions">
        {backend.kind === "tauri" && (
          <button className="btn" onClick={() => void backend.revealWorkspace().catch((e) => app.showToast(String(e)))}>
            <FolderOpen size={14} /> {t("打开文件夹")}
          </button>
        )}
        <button className="btn" onClick={() => void copyPath()}>
          <Copy size={14} /> {t("复制路径")}
        </button>
        <button className="btn primary" onClick={() => void app.pickWorkspace()}>
          <FolderSync size={14} /> {t("切换工作区…")}
        </button>
      </div>
      <p className="hint">{t("切换后会打开另一个工作区，当前的标签页会关闭；两个工作区的内容互不影响。")}</p>
    </>
  );
}

/** 点一下开始录入，按下新的组合键即保存；Esc 取消，Backspace 清除 */
function ShortcutInput({ def }: { def: CommandDef }) {
  const shortcuts = useSettings((s) => s.shortcuts);
  const [recording, setRecording] = useState(false);
  const current = shortcutOf(def.id, shortcuts);

  useEffect(() => {
    if (!recording) return;
    useSettings.setState({ capturing: true });
    const app = useAppStore.getState();
    const save = (combo: string | null) => {
      setRecording(false);
      void useSettings
        .getState()
        .setShortcut(def.id, combo)
        .catch((e) => app.showToast(String(e)));
    };
    // 在捕获阶段拦截，画布和页面上的快捷键都不会被触发
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(false);
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) return save(null);
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (!isAssignable(combo)) {
        app.showToast(t("快捷键需要包含 Ctrl 或 Alt，或者使用 F1–F12"));
        return;
      }
      const fixed = CANVAS_KEYS.find((k) => k.keys.includes(combo));
      if (fixed) {
        app.showToast(t("{key} 已用于画布中的「{action}」", { key: displayCombo(combo), action: t(fixed.label) }));
        return;
      }
      // 与其他操作重复时，把那个操作的快捷键清掉
      const other = COMMANDS.find((c) => c.id !== def.id && shortcutOf(c.id) === combo);
      if (other) {
        void useSettings.getState().setShortcut(other.id, null);
        app.showToast(t("{key} 原来用于「{action}」，已改给当前操作", { key: displayCombo(combo), action: t(other.label) }));
      }
      save(combo);
    };
    const cancel = () => setRecording(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      useSettings.setState({ capturing: false });
    };
  }, [recording, def.id]);

  const changed = current !== def.defaultKeys;
  return (
    <div className="shortcut-input">
      <button className={`shortcut-key${recording ? " is-recording" : ""}${current ? "" : " is-empty"}`} onClick={() => setRecording((r) => !r)}>
        {recording ? t("按下新的快捷键…") : current ? displayCombo(current) : t("未设置")}
      </button>
      <button
        className="icon-btn"
        title={def.defaultKeys ? t("恢复默认（{key}）", { key: displayCombo(def.defaultKeys) }) : t("恢复默认")}
        disabled={!changed}
        onClick={() => void useSettings.getState().setShortcut(def.id, def.defaultKeys).catch((e) => useAppStore.getState().showToast(String(e)))}
      >
        <RotateCcw size={14} />
      </button>
      <button
        className="icon-btn"
        title={t("清除")}
        disabled={!current}
        onClick={() => void useSettings.getState().setShortcut(def.id, null).catch((e) => useAppStore.getState().showToast(String(e)))}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ShortcutsSection() {
  useSettings((s) => s.shortcuts);
  const global = COMMANDS.filter((c) => c.global);
  const local = COMMANDS.filter((c) => !c.global);
  return (
    <>
      <div className="settings-title-row">
        <h2>{t("快捷键")}</h2>
        <button
          className="btn ghost"
          onClick={() =>
            void useSettings
              .getState()
              .resetShortcuts()
              .then(() => useAppStore.getState().showToast(t("已恢复默认快捷键")))
              .catch((e) => useAppStore.getState().showToast(String(e)))
          }
        >
          <RotateCcw size={14} /> {t("全部恢复默认")}
        </button>
      </div>
      <p className="settings-desc">{t("点击快捷键后按下新的组合键即可修改；录入时按 Esc 取消，按 Backspace 清除。")}</p>

      <h3>{t("全局")}</h3>
      {global.map((c) => (
        <Row key={c.id} title={t(c.label)} desc={isDesktop ? t("栖页在后台或最小化到托盘时也能用，按下后显示主界面。") : t("仅桌面端可用。")}>
          <ShortcutInput def={c} />
        </Row>
      ))}

      <h3>{t("应用内")}</h3>
      {local.map((c) => (
        <Row key={c.id} title={t(c.label)}>
          <ShortcutInput def={c} />
        </Row>
      ))}

      <h3>{t("画布")}</h3>
      <p className="settings-desc">{t("画布中的编辑快捷键固定不变。")}</p>
      <div className="shortcut-ref">
        {CANVAS_KEYS.map((k) => (
          <div key={k.label} className="shortcut-ref-row">
            <span>{t(k.label)}</span>
            <span className="shortcut-ref-keys">
              {k.keys.map((key) => (
                <kbd key={key}>{key === "Space" ? t("空格") : displayCombo(key)}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 检查更新、下载安装 */
function UpdatePanel() {
  const status = useUpdater((s) => s.status);
  const autoCheck = useSettings((s) => s.autoCheckUpdates);
  const busy = status.kind === "checking" || status.kind === "downloading" || status.kind === "installing";

  let message: ReactNode = null;
  if (!isDesktop) message = t("仅桌面端支持在线更新。");
  else if (status.kind === "checking") message = t("正在检查更新…");
  else if (status.kind === "latest") message = t("已是最新版本（{time}检查）", { time: formatRelative(status.checkedAt) });
  else if (status.kind === "error") message = <span className="update-error">{status.message}</span>;

  return (
    <div className="update-panel">
      <div className="update-head">
        <button className="btn" disabled={!isDesktop || busy} onClick={() => void checkForUpdates()}>
          <RefreshCw size={14} className={status.kind === "checking" ? "spin" : undefined} /> {t("检查更新")}
        </button>
        {message && <span className="update-message">{message}</span>}
      </div>

      {status.kind === "available" && (
        <div className="update-card">
          <div className="update-card-head">
            <strong>{t("发现新版本 v{version}", { version: status.version })}</strong>
            {status.date && <span className="hint">{status.date.slice(0, 10)}</span>}
          </div>
          {status.notes && <pre className="update-notes">{status.notes}</pre>}
          <button className="btn primary" onClick={() => void installUpdate(() => useCanvasStore.getState().flush())}>
            <Download size={14} /> {t("下载并安装")}
          </button>
          <p className="hint">{t("安装时栖页会关闭，装好后自动重新打开；未保存的修改会先保存。")}</p>
        </div>
      )}

      {(status.kind === "downloading" || status.kind === "installing") && (
        <div className="update-card">
          <strong>
            {status.kind === "installing"
              ? t("正在安装 v{version}，栖页将自动重启…", { version: status.version })
              : t("正在下载 v{version}", { version: status.version })}
          </strong>
          {status.kind === "downloading" && (
            <>
              <div className="progress">
                <div style={{ width: status.total ? `${Math.min(100, (status.received / status.total) * 100)}%` : "30%" }} />
              </div>
              <span className="hint">
                {formatBytes(status.received)}
                {status.total ? ` / ${formatBytes(status.total)}` : ""}
              </span>
            </>
          )}
        </div>
      )}

      <Row title={t("启动时自动检查更新")} desc={t("有新版本时，设置按钮上会出现一个小圆点。")}>
        <Segmented
          value={autoCheck ? "on" : "off"}
          options={[
            { value: "on", label: t("开启") },
            { value: "off", label: t("关闭") },
          ]}
          onChange={(v) => useSettings.getState().setAutoCheckUpdates(v === "on")}
        />
      </Row>
    </div>
  );
}

function AboutSection() {
  return (
    <>
      <h2>{t("关于")}</h2>
      <div className="settings-about">
        <img src="/lattira.svg" alt="" width={56} height={56} />
        <div>
          <div className="settings-about-name">{t("栖页 · Lattira")}</div>
          <div className="settings-about-version">
            {t("版本")} {__APP_VERSION__}
          </div>
        </div>
      </div>
      <p className="settings-desc">{t("用画布整理文本、文件与图片，按项目归档，按日期回溯。")}</p>
      <UpdatePanel />
      <p className="settings-author">By Dereen</p>
    </>
  );
}

export function SettingsView({ section = "general" }: { section?: SettingsSection }) {
  useT();
  const navigate = useAppStore((s) => s.navigate);
  return (
    <div className="page settings-page">
      <nav className="settings-nav">
        <h1>{t("设置")}</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`nav-item${section === s.id ? " is-active" : ""}`}
            onClick={() => navigate({ kind: "settings", section: s.id })}
          >
            {s.icon}
            <span>{t(s.label)}</span>
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-content">
          {section === "general" && <GeneralSection />}
          {section === "workspace" && <WorkspaceSection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
