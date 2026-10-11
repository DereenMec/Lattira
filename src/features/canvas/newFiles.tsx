import { operationTarget } from "@/lib/operations";
/**
 * 右键菜单里的「新建」：画布上的卡片（文本卡片、文件夹、链接），以及与 Windows 右键菜单「新建」一致的文件类型。
 * Windows 的「文件夹」「快捷方式」在栖页里对应文件夹卡片和链接卡片，不再单独列出。
 * 画布空白处和文件夹窗口空白处共用这一个菜单，见 CanvasView 与 FolderPanel。
 */
import { FilePlus, Folder, Link2, StickyNote } from "lucide-react";
import type { MenuEntry } from "@/features/menu/ContextMenu";
import { promptText } from "@/features/menu/PromptDialog";
import { t } from "@/i18n";
import { fileIconUrl } from "@/lib/fileIcons";
import type { Point } from "@/lib/geometry";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { ID, NewFileType } from "@/types/model";
import { uniqueName } from "@/lib/names";
import { nameError, namesAt } from "./cardNames";
import { elementsForAssets } from "./placement";

const S = 15;

/** 上次读到的文件类型；菜单是同步生成的，打开菜单时先用它，同时在后台刷新（装了新软件后下次就有） */
let cached: NewFileType[] = [];
let loading: Promise<void> | null = null;

export function loadNewFileTypes(): Promise<void> {
  loading ??= backend
    .listNewFileTypes()
    .then((types) => {
      cached = [...types].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    })
    .catch((e) => console.warn("[newFiles] 读取系统的新建文件类型失败", e))
    .finally(() => (loading = null));
  return loading;
}

/**
 * 新建一个文件，卡片放在 at（中心对准）或放进文件夹 parentId。
 * 不和这一层已有的文件、文件夹重名：默认名「新建 文本文档.txt」已有时用「新建 文本文档 (2).txt」，与资源管理器一致
 */
async function createFile(type: NewFileType, at: Point, parentId?: ID) {
  const operation = operationTarget(parentId);
  const label = t("新建 {type}", { type: type.name });
  const taken = namesAt(parentId);
  const name = await promptText(label, uniqueName(`${label}${type.ext}`, taken, { ext: true }), {
    selectStem: true,
    // 与后台一致：没以这个扩展名结尾时补上
    validate: (v) => nameError(v.toLowerCase().endsWith(type.ext) ? v : `${v}${type.ext}`, taken),
  });
  if (name === null || !operation.valid()) return;
  try {
    const asset = await backend.createNewFile(type.ext, name);
    if (!operation.valid()) return;
    useAppStore.getState().addAssets([asset]);
    const [card] = elementsForAssets([asset], at);
    const placed = { ...card, x: card.x - card.width / 2, y: card.y - card.height / 2, ...(parentId ? { parentId } : {}) };
    const s = useCanvasStore.getState();
    s.addElements([placed], { select: !parentId });
    if (parentId) s.showInOpenFolder(parentId, [placed.id]);
  } catch (e) {
    useAppStore.getState().showToast(t("新建文件失败：{error}", { error: String(e) }));
  }
}

interface NewMenuOptions {
  /** 新卡片的位置（画布坐标）；放进文件夹时只用于记录 */
  at: Point;
  /** 建在哪个文件夹里；为空时放在画布上 */
  parentId?: ID;
  /** 文本卡片的快捷操作提示，如画布上的「双击」 */
  textHint?: string;
  text(): void;
  folder(): void;
  link(): void;
}

/** 「新建」子菜单 */
export function newMenuEntry(opts: NewMenuOptions): MenuEntry {
  void loadNewFileTypes();
  const files: MenuEntry[] = cached.length
    ? cached.map((type) => ({
        label: type.name,
        icon: <img src={fileIconUrl(`x${type.ext}`)} alt="" width={S} height={S} draggable={false} />,
        onSelect: () => void createFile(type, opts.at, opts.parentId),
      }))
    : [{ label: t("系统里没有其他可新建的文件类型"), disabled: true }];
  return {
    label: t("新建"),
    icon: <FilePlus size={S} />,
    children: [
      { label: t("文本卡片"), icon: <StickyNote size={S} />, hint: opts.textHint, onSelect: opts.text },
      { label: t("文件夹"), icon: <Folder size={S} />, onSelect: opts.folder },
      { label: t("链接…"), icon: <Link2 size={S} />, onSelect: opts.link },
      "separator",
      ...files,
    ],
  };
}
