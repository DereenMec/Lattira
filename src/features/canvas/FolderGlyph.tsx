/** 文件夹图标：画布上的文件夹卡片与文件夹窗口共用，颜色见 styles.css 的 --folder */
export function FolderGlyph({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`folder-glyph ${className}`} width={size} height={size * 0.8} viewBox="0 0 40 32" aria-hidden>
      <path
        className="folder-back"
        d="M2 5a3 3 0 0 1 3-3h9.2a3 3 0 0 1 2.1.9l2.4 2.4a3 3 0 0 0 2.1.9H35a3 3 0 0 1 3 3V27a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z"
      />
      <path className="folder-front" d="M2 11a3 3 0 0 1 3-3h30a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" />
    </svg>
  );
}
