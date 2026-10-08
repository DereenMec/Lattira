import { Check, X } from "lucide-react";
import { create } from "zustand";
import { t, useT } from "@/i18n";
import { useAppStore } from "@/store/appStore";
import type { ID } from "@/types/model";
import { PROJECT_ICONS, PROJECT_PALETTE, ProjectIcon } from "./projectIcons";

const useStyleDialog = create<{ projectId: ID | null }>(() => ({ projectId: null }));

export const openProjectStyle = (projectId: ID) => useStyleDialog.setState({ projectId });

/** 修改项目的颜色与图标；点选即生效 */
export function ProjectStyleDialog() {
  const projectId = useStyleDialog((s) => s.projectId);
  useT();
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  if (!project) return null;

  const close = () => useStyleDialog.setState({ projectId: null });
  const update = (patch: { color?: string; icon?: string }) =>
    useAppStore
      .getState()
      .updateProject(project.id, patch)
      .catch((e) => useAppStore.getState().showToast(t("修改失败：{error}", { error: String(e) })));
  const isPreset = PROJECT_PALETTE.some((c) => c.toLowerCase() === project.color.toLowerCase());

  return (
    <div className="overlay" onPointerDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dialog style-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <ProjectIcon project={project} size={18} />
          <h3>{project.name}</h3>
          <button className="icon-btn" onClick={close} title={t("关闭")}>
            <X size={16} />
          </button>
        </header>

        <h4>{t("颜色")}</h4>
        <div className="style-colors">
          {PROJECT_PALETTE.map((c) => (
            <button
              key={c}
              className={`style-color${c.toLowerCase() === project.color.toLowerCase() ? " is-active" : ""}`}
              style={{ background: c }}
              onClick={() => void update({ color: c })}
              title={c}
            >
              {c.toLowerCase() === project.color.toLowerCase() && <Check size={14} color="#fff" />}
            </button>
          ))}
          <label className={`style-color custom${isPreset ? "" : " is-active"}`} title={t("自定义颜色")} style={isPreset ? undefined : { background: project.color }}>
            <input type="color" value={project.color} onChange={(e) => void update({ color: e.target.value })} />
            {isPreset ? "+" : <Check size={14} color="#fff" />}
          </label>
        </div>

        <h4>{t("图标")}</h4>
        <div className="style-icons">
          <button
            className={`style-icon${!project.icon ? " is-active" : ""}`}
            onClick={() => void update({ icon: "" })}
            title={t("圆点")}
          >
            <span className="dot" style={{ background: project.color, width: 10, height: 10 }} />
          </button>
          {Object.entries(PROJECT_ICONS).map(([key, { icon: Icon, label }]) => (
            <button
              key={key}
              className={`style-icon${project.icon === key ? " is-active" : ""}`}
              onClick={() => void update({ icon: key })}
              title={t(label)}
            >
              <Icon size={17} color={project.color} strokeWidth={2.2} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
