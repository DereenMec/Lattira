/** 各类对象的右键菜单内容；菜单在打开时生成，文字按当前语言翻译 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Archive,
  Folder,
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardCopy,
  Copy,
  CopyPlus,
  ExternalLink,
  FileInput,
  FileOutput,
  FilePen,
  FilePlus,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Image as ImageIcon,
  Link,
  Pencil,
  RefreshCw,
  Save,
  ScanText,
  Scissors,
  Trash2,
  Ungroup,
} from "lucide-react";
import type { ReactNode } from "react";
import { copySelection, cutSelection } from "@/features/canvas/clipboard";
import { ownAssetForCanvas } from "@/features/canvas/assetEditing";
import { editLink, fetchPreview, openLink } from "@/features/canvas/links";
import { exportCanvas, importCanvases } from "@/features/canvas/transfer";
import { openProjectStyle } from "@/features/project/ProjectStyleDialog";
import { ProjectIcon } from "@/features/project/projectIcons";
import { t } from "@/i18n";
import { folderChain, folderName, isFolder, withDescendants } from "@/lib/folders";
import { confirmAction } from "@/services/confirm";
import { backend } from "@/services/backend";
import { projectLabel, useAppStore } from "@/store/appStore";
import { useCanvasStore, type AlignMode } from "@/store/canvasStore";
import {
  CARD_COLORS,
  type Asset,
  type CanvasElement,
  type CanvasMeta,
  type CardColor,
  type ID,
  type FolderElement,
  type Project,
} from "@/types/model";
import type { MenuEntry } from "./ContextMenu";
import { promptText } from "./PromptDialog";

const S = 15;
const app = () => useAppStore.getState();
const cv = () => useCanvasStore.getState();

/** 执行一个可能失败的动作，失败时提示；what 为已翻译的动作名 */
async function attempt(what: string, fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    app().showToast(t("{what}失败：{error}", { what, error: String(e) }));
  }
}

async function copyText(text: string, what: string) {
  await attempt(t("复制"), async () => {
    await navigator.clipboard.writeText(text);
    app().showToast(t("已复制{what}", { what }));
  });
}

/** 复制图片到剪贴板：统一转成 PNG，剪贴板只稳定支持这一种格式 */
async function copyImage(asset: Asset) {
  await attempt(t("复制图片"), async () => {
    const blob = await (await fetch(backend.assetUrl(asset))).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    app().showToast(t("已复制图片"));
  });
}

/** 重命名文件；inCanvas 时只改这个画布用的那份（见 ownAssetForCanvas） */
async function renameAsset(asset: Asset, inCanvas: boolean) {
  const name = await promptText(t("重命名文件"), asset.name);
  if (!name || name === asset.name) return;
  await attempt(t("重命名"), async () => {
    const target = inCanvas ? await ownAssetForCanvas(asset) : asset;
    const renamed = await backend.renameAsset(target, name);
    app().addAssets([renamed]);
    app().showToast(t("已重命名为「{name}」", { name: renamed.name }));
  });
}

/**
 * 文件与图片共用的条目：打开、在资源管理器中显示、复制、重命名、另存为。
 * inCanvas 为 true（画布、文件夹窗口、检查器里）时，会拿到文件本身的操作（打开、显示位置、复制路径、重命名）
 * 用这个画布自己的那份，在这里修改不影响其他画布，见 features/canvas/assetEditing.ts；资源库里操作的是原来那份
 */
export function assetEntries(asset: Asset, inCanvas = false): MenuEntry[] {
  const desktop = backend.kind === "tauri";
  const image = asset.mime.startsWith("image/");
  const own = () => (inCanvas ? ownAssetForCanvas(asset) : Promise.resolve(asset));
  return [
    {
      label: t("打开"),
      icon: <ExternalLink size={S} />,
      hint: t("双击"),
      onSelect: () => attempt(t("打开文件"), async () => backend.openAsset(await own())),
    },
    {
      label: t("在资源管理器中显示"),
      icon: <FolderOpen size={S} />,
      disabled: !desktop,
      onSelect: () => attempt(t("打开资源管理器"), async () => backend.revealAsset(await own())),
    },
    ...(image
      ? ([
          { label: t("复制图片"), icon: <ImageIcon size={S} />, onSelect: () => void copyImage(asset) },
          ...(asset.ocrText
            ? [{ label: t("复制图中文字"), icon: <ScanText size={S} />, onSelect: () => void copyText(asset.ocrText!, t("图中文字")) }]
            : []),
        ] as MenuEntry[])
      : []),
    {
      label: t("复制文件路径"),
      icon: <Link size={S} />,
      disabled: !desktop,
      onSelect: () => void attempt(t("复制"), async () => copyText(backend.assetPath(await own()), t("文件路径"))),
    },
    { label: t("重命名…"), icon: <FilePen size={S} />, onSelect: () => void renameAsset(asset, inCanvas) },
    {
      label: t("另存为…"),
      icon: <Save size={S} />,
      onSelect: () =>
        attempt(t("另存为"), async () => {
          if (await backend.saveAssetCopy(asset)) app().showToast(t("已另存「{name}」", { name: asset.name }));
        }),
    },
  ];
}

function colorEntry(onPick: (c: CardColor) => void, current?: CardColor): MenuEntry {
  return {
    label: t("颜色"),
    render: (close) => (
      <div className="ctx-swatches">
        {CARD_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch color-${c}${(current ?? "default") === c ? " is-active" : ""}`}
            title={c}
            onClick={() => {
              close();
              onPick(c);
            }}
          />
        ))}
      </div>
    ),
  };
}

/** 文件夹的显示名：嵌套时带上外层文件夹，如「资料 / 图纸」 */
export function folderPath(byId: ReadonlyMap<ID, CanvasElement>, id: ID): string {
  return folderChain(byId, id)
    .map((f) => folderName(f, t("未命名文件夹")))
    .join(" / ");
}

/** 「移到文件夹」：列出画布上的全部文件夹（不含移动的文件夹及其里面的、以及它们当前所在的那个） */
function moveToFolderEntry(ids: ID[]): MenuEntry {
  const doc = cv().doc!;
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const moving = withDescendants(doc.elements, ids);
  const parents = new Set(ids.map((id) => byId.get(id)?.parentId));
  const current = parents.size === 1 ? [...parents][0] : undefined;
  const targets = doc.elements
    .filter((e): e is FolderElement => isFolder(e) && !moving.has(e.id) && e.id !== current)
    .map((f) => ({ f, path: folderPath(byId, f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  return {
    label: t("移到文件夹"),
    icon: <FolderSymlink size={S} />,
    disabled: targets.length === 0,
    hint: targets.length === 0 ? t("没有其他文件夹") : undefined,
    children: targets.length
      ? targets.map(({ f, path }) => ({
          label: path,
          icon: <Folder size={S} />,
          onSelect: () => {
            if (!cv().moveIntoFolder(ids, f.id)) return;
            app().showToast(t("已移到「{name}」", { name: folderName(f, t("未命名文件夹")) }));
          },
        }))
      : undefined,
  };
}

export async function renameFolder(f: FolderElement) {
  const label = await promptText(t("重命名文件夹"), f.label);
  if (label !== null && label !== f.label) cv().updateElements({ [f.id]: { label } });
}

const alignOptions = (): { mode: AlignMode; label: string; icon: ReactNode }[] => [
  { mode: "left", label: t("左对齐"), icon: <AlignStartVertical size={S} /> },
  { mode: "hcenter", label: t("水平居中"), icon: <AlignCenterVertical size={S} /> },
  { mode: "right", label: t("右对齐"), icon: <AlignEndVertical size={S} /> },
  { mode: "top", label: t("顶端对齐"), icon: <AlignStartHorizontal size={S} /> },
  { mode: "vcenter", label: t("垂直居中"), icon: <AlignCenterHorizontal size={S} /> },
  { mode: "bottom", label: t("底端对齐"), icon: <AlignEndHorizontal size={S} /> },
];

function removeElements(ids: ID[]) {
  cv().select(ids);
  cv().deleteSelection();
}

const arrangeEntries = (ids: ID[]): MenuEntry[] => [
  { label: t("复制"), icon: <ClipboardCopy size={S} />, hint: "Ctrl+C", onSelect: () => void copySelection() },
  { label: t("剪切"), icon: <Scissors size={S} />, hint: "Ctrl+X", onSelect: () => void cutSelection() },
  { label: t("创建副本"), icon: <CopyPlus size={S} />, hint: "Ctrl+D", onSelect: () => cv().duplicate(ids) },
  { label: t("置于顶层"), icon: <ArrowUpToLine size={S} />, onSelect: () => cv().reorder(ids, "front") },
  { label: t("置于底层"), icon: <ArrowDownToLine size={S} />, onSelect: () => cv().reorder(ids, "back") },
];

/** 画布中选中元素的右键菜单 */
export function elementMenu(ids: ID[]): MenuEntry[] {
  const doc = cv().doc;
  if (!doc) return [];
  const els = doc.elements.filter((e) => ids.includes(e.id));
  const setColor = (targets: CanvasElement[]) => (color: CardColor) =>
    cv().updateElements(Object.fromEntries(targets.map((e) => [e.id, { color }])));

  if (els.length === 1) {
    const el = els[0];
    if (el.type === "text") {
      return [
        { label: t("编辑"), icon: <Pencil size={S} />, hint: t("双击"), onSelect: () => cv().openEditor(el.id) },
        { label: t("复制文字"), icon: <Copy size={S} />, onSelect: () => void copyText(el.text, t("文字")) },
        "separator",
        colorEntry(setColor([el]), el.color),
        "separator",
        moveToFolderEntry(ids),
        ...arrangeEntries(ids),
        "separator",
        { label: t("删除"), icon: <Trash2 size={S} />, hint: "Delete", danger: true, onSelect: () => removeElements(ids) },
      ];
    }
    if (el.type === "link") {
      return [
        { label: t("在浏览器中打开"), icon: <ExternalLink size={S} />, hint: t("双击"), onSelect: () => void openLink(el.url) },
        { label: t("复制网址"), icon: <Copy size={S} />, onSelect: () => void copyText(el.url, t("网址")) },
        { label: t("修改网址…"), icon: <Pencil size={S} />, onSelect: () => void editLink(el) },
        { label: t("刷新预览"), icon: <RefreshCw size={S} />, onSelect: () => void fetchPreview(el, true) },
        "separator",
        colorEntry(setColor([el]), el.color),
        "separator",
        moveToFolderEntry(ids),
        ...arrangeEntries(ids),
        "separator",
        { label: t("删除"), icon: <Trash2 size={S} />, hint: "Delete", danger: true, onSelect: () => removeElements(ids) },
      ];
    }
    if (el.type === "folder") {
      const inside = withDescendants(doc.elements, [el.id]).size - 1;
      return [
        { label: t("打开"), icon: <FolderOpen size={S} />, hint: t("双击"), onSelect: () => cv().openFolder(el.id) },
        { label: t("重命名"), icon: <Pencil size={S} />, hint: "F2", onSelect: () => cv().setEditing(el.id) },
        colorEntry(setColor([el]), el.color),
        "separator",
        moveToFolderEntry(ids),
        {
          label: t("解散文件夹（内容放回画布）"),
          icon: <Ungroup size={S} />,
          disabled: inside === 0,
          onSelect: () => cv().dissolveFolder(el.id),
        },
        ...arrangeEntries(ids),
        "separator",
        {
          label: inside ? t("删除文件夹和其中的 {n} 项", { n: inside }) : t("删除文件夹"),
          icon: <Trash2 size={S} />,
          hint: "Delete",
          danger: true,
          onSelect: () => removeElements(ids),
        },
      ];
    }
    const asset = app().assets.get(el.assetId);
    return [
      ...(asset ? assetEntries(asset, true) : []),
      "separator",
      moveToFolderEntry(ids),
      ...arrangeEntries(ids),
      "separator",
      { label: t("从画布移除"), icon: <Trash2 size={S} />, hint: "Delete", danger: true, onSelect: () => removeElements(ids) },
    ];
  }

  const colorable = els.filter((e) => e.type === "text" || e.type === "link" || e.type === "folder");
  const align = alignOptions();
  return [
    { label: t("放进文件夹"), icon: <FolderPlus size={S} />, hint: "Ctrl+G", onSelect: () => cv().groupSelection() },
    {
      label: t("对齐"),
      icon: <AlignStartVertical size={S} />,
      children: [
        ...align.slice(0, 3).map((a) => ({ label: a.label, icon: a.icon, onSelect: () => cv().align(ids, a.mode) })),
        "separator" as const,
        ...align.slice(3).map((a) => ({ label: a.label, icon: a.icon, onSelect: () => cv().align(ids, a.mode) })),
      ],
    },
    {
      label: t("等距分布"),
      icon: <AlignCenterVertical size={S} />,
      disabled: els.length < 3,
      children: [
        { label: t("水平等距"), onSelect: () => cv().distribute(ids, "x") },
        { label: t("垂直等距"), onSelect: () => cv().distribute(ids, "y") },
      ],
    },
    ...(colorable.length ? (["separator", colorEntry(setColor(colorable))] as MenuEntry[]) : []),
    "separator",
    moveToFolderEntry(ids),
    ...arrangeEntries(ids),
    "separator",
    {
      label: t("删除 {n} 项", { n: els.length }),
      icon: <Trash2 size={S} />,
      hint: "Delete",
      danger: true,
      onSelect: () => removeElements(ids),
    },
  ];
}

/** 文件夹窗口里选中的内容的右键菜单；open 打开（进入子文件夹、打开文件等），moveOut 拿到画布上 */
export function folderItemMenu(ids: ID[], actions: { open(id: ID): void; moveOut(): void }): MenuEntry[] {
  const doc = cv().doc;
  if (!doc) return [];
  const els = doc.elements.filter((e) => ids.includes(e.id));
  const common: MenuEntry[] = [
    { label: t("移到画布"), icon: <ArrowUpToLine size={S} />, onSelect: actions.moveOut },
    moveToFolderEntry(ids),
    { label: t("复制"), icon: <ClipboardCopy size={S} />, hint: "Ctrl+C", onSelect: () => void copySelection(ids) },
    { label: t("剪切"), icon: <Scissors size={S} />, hint: "Ctrl+X", onSelect: () => void cutSelection(ids) },
  ];
  const remove: MenuEntry = {
    label: els.length > 1 ? t("删除 {n} 项", { n: els.length }) : t("删除"),
    icon: <Trash2 size={S} />,
    hint: "Delete",
    danger: true,
    onSelect: () => cv().deleteElements(ids),
  };
  if (els.length !== 1) return [...common, "separator", remove];
  const el = els[0];
  let own: MenuEntry[] = [];
  if (el.type === "folder") {
    own = [
      { label: t("打开"), icon: <FolderOpen size={S} />, hint: t("双击"), onSelect: () => actions.open(el.id) },
      { label: t("重命名…"), icon: <Pencil size={S} />, hint: "F2", onSelect: () => void renameFolder(el) },
    ];
  } else if (el.type === "text") {
    own = [
      { label: t("编辑"), icon: <Pencil size={S} />, hint: t("双击"), onSelect: () => cv().openEditor(el.id) },
      { label: t("复制文字"), icon: <Copy size={S} />, onSelect: () => void copyText(el.text, t("文字")) },
    ];
  } else if (el.type === "link") {
    own = [
      { label: t("在浏览器中打开"), icon: <ExternalLink size={S} />, hint: t("双击"), onSelect: () => void openLink(el.url) },
      { label: t("复制网址"), icon: <Copy size={S} />, onSelect: () => void copyText(el.url, t("网址")) },
    ];
  } else {
    const asset = app().assets.get(el.assetId);
    own = asset ? assetEntries(asset, true) : [];
  }
  return [...own, ...(own.length ? (["separator"] as MenuEntry[]) : []), ...common, "separator", remove];
}

/** 画布卡片（项目页、最近页、日历）的右键菜单 */
export function canvasMenu(canvas: CanvasMeta): MenuEntry[] {
  const { projects, navigate, updateCanvas, deleteCanvas } = app();
  const targets = projects.filter((p) => !p.archived && p.id !== canvas.projectId);
  return [
    { label: t("打开"), icon: <ExternalLink size={S} />, onSelect: () => navigate({ kind: "canvas", canvasId: canvas.id }) },
    {
      label: t("重命名…"),
      icon: <Pencil size={S} />,
      onSelect: async () => {
        const title = await promptText(t("重命名画布"), canvas.title);
        if (title && title !== canvas.title) await attempt(t("重命名"), () => updateCanvas(canvas.id, { title }));
      },
    },
    {
      label: t("移动到"),
      icon: <FolderInput size={S} />,
      disabled: targets.length === 0,
      children: targets.map((p) => ({
        label: projectLabel(p),
        icon: <ProjectIcon project={p} size={14} />,
        onSelect: () =>
          attempt(t("移动"), async () => {
            await updateCanvas(canvas.id, { projectId: p.id });
            app().showToast(t("已把「{canvas}」移到「{project}」", { canvas: canvas.title, project: projectLabel(p) }));
          }),
      })),
    },
    {
      label: t("在资源管理器中显示"),
      icon: <FolderOpen size={S} />,
      disabled: backend.kind !== "tauri",
      onSelect: () => attempt(t("打开资源管理器"), () => backend.revealCanvas(canvas.id)),
    },
    { label: t("导出…"), icon: <FileOutput size={S} />, onSelect: () => void exportCanvas(canvas) },
    "separator",
    {
      label: t("删除"),
      icon: <Trash2 size={S} />,
      danger: true,
      onSelect: async () => {
        if (await confirmAction(t("删除画布「{name}」？之后可以在回收站中恢复。", { name: canvas.title }))) {
          await attempt(t("删除"), () => deleteCanvas(canvas.id));
        }
      },
    },
  ];
}

/** 侧栏项目的右键菜单 */
export function projectMenu(project: Project): MenuEntry[] {
  const { navigate, createCanvas, updateProject } = app();
  return [
    { label: t("打开"), icon: <ExternalLink size={S} />, onSelect: () => navigate({ kind: "project", projectId: project.id }) },
    { label: t("新建画布"), icon: <FilePlus size={S} />, onSelect: () => attempt(t("新建画布"), () => createCanvas(project.id)) },
    { label: t("导入画布…"), icon: <FileInput size={S} />, onSelect: () => void importCanvases(project.id) },
    ...(project.isInbox
      ? []
      : ([
          {
            label: t("重命名…"),
            icon: <Pencil size={S} />,
            onSelect: async () => {
              const name = await promptText(t("重命名项目"), project.name);
              if (name && name !== project.name) await attempt(t("重命名"), () => updateProject(project.id, { name }));
            },
          },
          {
            label: t("图标和颜色…"),
            icon: <ProjectIcon project={project} size={14} />,
            onSelect: () => openProjectStyle(project.id),
          },
        ] as MenuEntry[])),
    {
      label: t("在资源管理器中打开"),
      icon: <FolderOpen size={S} />,
      disabled: backend.kind !== "tauri",
      onSelect: () => attempt(t("打开文件夹"), () => backend.revealProject(project.id)),
    },
    ...(project.isInbox
      ? []
      : ([
          "separator",
          {
            label: t("归档"),
            icon: <Archive size={S} />,
            onSelect: async () => {
              if (await confirmAction(t("归档项目「{name}」？归档后它不再显示在侧栏，画布仍保留在磁盘上。", { name: project.name }))) {
                await attempt(t("归档"), () => updateProject(project.id, { archived: true }));
              }
            },
          },
        ] as MenuEntry[])),
  ];
}
