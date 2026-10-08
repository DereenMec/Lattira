/** 各类对象的右键菜单内容；菜单在打开时生成，文字按当前语言翻译 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Archive,
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardCopy,
  Copy,
  CopyPlus,
  ExternalLink,
  FilePen,
  FilePlus,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Link,
  Pencil,
  Save,
  ScanText,
  Trash2,
  Ungroup,
} from "lucide-react";
import type { ReactNode } from "react";
import { copySelection } from "@/features/canvas/clipboard";
import { openProjectStyle } from "@/features/project/ProjectStyleDialog";
import { ProjectIcon } from "@/features/project/projectIcons";
import { t } from "@/i18n";
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

async function renameAsset(asset: Asset) {
  const name = await promptText(t("重命名文件"), asset.name);
  if (!name || name === asset.name) return;
  await attempt(t("重命名"), async () => {
    const renamed = await backend.renameAsset(asset, name);
    app().addAssets([renamed]);
    app().showToast(t("已重命名为「{name}」", { name: renamed.name }));
  });
}

/** 文件与图片共用的条目：打开、在资源管理器中显示、复制、重命名、另存为 */
export function assetEntries(asset: Asset): MenuEntry[] {
  const desktop = backend.kind === "tauri";
  const image = asset.mime.startsWith("image/");
  return [
    {
      label: t("打开"),
      icon: <ExternalLink size={S} />,
      hint: t("双击"),
      onSelect: () => attempt(t("打开文件"), () => backend.openAsset(asset)),
    },
    {
      label: t("在资源管理器中显示"),
      icon: <FolderOpen size={S} />,
      disabled: !desktop,
      onSelect: () => attempt(t("打开资源管理器"), () => backend.revealAsset(asset)),
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
      onSelect: () => void copyText(backend.assetPath(asset), t("文件路径")),
    },
    { label: t("重命名…"), icon: <FilePen size={S} />, onSelect: () => void renameAsset(asset) },
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
        ...arrangeEntries(ids),
        "separator",
        { label: t("删除"), icon: <Trash2 size={S} />, hint: "Delete", danger: true, onSelect: () => removeElements(ids) },
      ];
    }
    if (el.type === "section") {
      const inside = doc.elements.filter(
        (o) => o.id !== el.id && o.x >= el.x && o.y >= el.y && o.x + o.width <= el.x + el.width && o.y + o.height <= el.y + el.height,
      );
      return [
        { label: t("重命名"), icon: <Pencil size={S} />, hint: t("双击标题"), onSelect: () => cv().setEditing(el.id) },
        colorEntry(setColor([el]), el.color),
        "separator",
        { label: t("解散文件夹（保留卡片）"), icon: <Ungroup size={S} />, onSelect: () => cv().ungroup(el.id) },
        "separator",
        {
          label: t("删除文件夹和其中的 {n} 张卡片", { n: inside.length }),
          icon: <Trash2 size={S} />,
          danger: true,
          onSelect: () => removeElements([el.id, ...inside.map((o) => o.id)]),
        },
      ];
    }
    const asset = app().assets.get(el.assetId);
    return [
      ...(asset ? assetEntries(asset) : []),
      "separator",
      ...arrangeEntries(ids),
      "separator",
      { label: t("从画布移除"), icon: <Trash2 size={S} />, hint: "Delete", danger: true, onSelect: () => removeElements(ids) },
    ];
  }

  const colorable = els.filter((e) => e.type === "text" || e.type === "section");
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
    "separator",
    {
      label: t("删除"),
      icon: <Trash2 size={S} />,
      danger: true,
      onSelect: async () => {
        if (await confirmAction(t("删除画布「{name}」？画布文件会移到工作区的回收站文件夹。", { name: canvas.title }))) {
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
