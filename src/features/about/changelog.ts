import { msg } from "@/i18n";

/** 关于界面中的更新内容；条目是中文原文，英文界面通过 t() 翻译 */
export interface Release {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: "0.3.0",
    date: "2026-10-08",
    items: [
      msg("画布内查找（Ctrl+F），可以查到图片中的文字"),
      msg("卡片复制粘贴（Ctrl+C / Ctrl+V），文件可直接粘贴到微信、资源管理器"),
      msg("右键菜单：卡片、画布、连线、项目、文件"),
      msg("文本卡片双击打开大窗口编辑"),
      msg("导入文件夹：文件夹变成分组，里面的文件自动排好"),
      msg("按文件类型显示图标，支持 draw.io"),
      msg("未选中卡片时，右侧列出画布中的全部文件"),
      msg("资源库：列表视图、独立搜索、多选删除、重命名文件"),
      msg("自定义项目的图标和颜色"),
      msg("最近页可以直接新建画布"),
      msg("内置 Maple Mono NF CN 字体"),
      msg("英文界面，关于界面"),
    ],
  },
  {
    version: "0.2.0",
    date: "2026-10-08",
    items: [
      msg("新增「最近」，「收件箱」改名为「未分类」"),
      msg("把画布拖到侧栏的项目上即可移动"),
      msg("识别图片中的文字（OCR），并可搜索"),
      msg("全局搜索快捷键改为 Ctrl+E"),
      msg("画布缩略图与小地图"),
      msg("大画布性能优化"),
    ],
  },
  {
    version: "0.1.0",
    date: "2026-10-08",
    items: [
      msg("无限画布：文本、图片、文件卡片，分组框与连线"),
      msg("项目、日历、资源库与全局搜索"),
      msg("数据保存在本地工作区，画布文件兼容 JSON Canvas"),
    ],
  },
];
