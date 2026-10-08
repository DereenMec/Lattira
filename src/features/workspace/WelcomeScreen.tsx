import { FolderOpen } from "lucide-react";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";

export function WelcomeScreen() {
  return (
    <div className="welcome">
      <img src="/lattira.svg" alt="" width={64} height={64} />
      <h1>栖页 · Lattira</h1>
      <p>用画布整理文本、文件与图片，按项目归档，按日期回溯。</p>
      <button className="btn primary large" onClick={() => void useAppStore.getState().pickWorkspace()}>
        <FolderOpen size={16} /> {backend.kind === "tauri" ? "选择工作区文件夹" : "进入浏览器预览"}
      </button>
      <p className="hint">
        {backend.kind === "tauri"
          ? "工作区就是你磁盘上的一个普通文件夹，所有画布和导入的文件都保存在里面。"
          : "当前在浏览器中运行：数据只保存在本浏览器里，导入的文件刷新后不会保留。"}
      </p>
    </div>
  );
}
