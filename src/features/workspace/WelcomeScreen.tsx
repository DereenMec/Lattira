import { FolderOpen } from "lucide-react";
import { backend } from "@/services/backend";
import { setLocale, useLocale, useT } from "@/i18n";
import { useAppStore } from "@/store/appStore";

export function WelcomeScreen() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  return (
    <div className="welcome">
      <img src="/lattira.svg" alt="" width={64} height={64} />
      <h1>{t("栖页 · Lattira")}</h1>
      <p>{t("用画布整理文本、文件与图片，按项目归档，按日期回溯。")}</p>
      <button className="btn primary large" onClick={() => void useAppStore.getState().pickWorkspace()}>
        <FolderOpen size={16} /> {backend.kind === "tauri" ? t("选择工作区文件夹") : t("进入浏览器预览")}
      </button>
      <p className="hint">
        {backend.kind === "tauri"
          ? t("工作区就是你磁盘上的一个普通文件夹，所有画布和导入的文件都保存在里面。")
          : t("当前在浏览器中运行：画布与导入的文件保存在本浏览器里；清除网站数据会将它们删除。")}
      </p>
      <button className="btn ghost welcome-lang" onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
        {locale === "zh" ? "English" : "中文"}
      </button>
    </div>
  );
}
