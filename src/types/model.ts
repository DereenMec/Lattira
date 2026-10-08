/** 栖页核心数据模型，对应设计文档第 6 节「核心数据模型」。 */

export type ID = string;

/** 毫秒时间戳 */
export type Timestamp = number;

/** 本地日期，格式 YYYY-MM-DD */
export type LocalDate = string;

export interface WorkspaceInfo {
  /** 工作区根目录的绝对路径（浏览器预览模式下为虚拟路径） */
  path: string;
  name: string;
  /** 本次打开时是否为新建的工作区（用于生成欢迎画布） */
  isNew: boolean;
}

export interface Project {
  id: ID;
  name: string;
  color: string;
  /** 系统自带的「未分类」项目，不可删除、不可重命名 */
  isInbox: boolean;
  pinned: boolean;
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CanvasMeta {
  id: ID;
  projectId: ID;
  title: string;
  elementCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** 缩略图数据，见 lib/preview.ts；尚未生成时为空 */
  preview?: string | null;
}

export type ElementType = "text" | "image" | "file" | "section";

export const CARD_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

interface ElementBase {
  id: ID;
  type: ElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CardColor;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TextElement extends ElementBase {
  type: "text";
  text: string;
}

export interface ImageElement extends ElementBase {
  type: "image";
  assetId: ID;
}

export interface FileElement extends ElementBase {
  type: "file";
  assetId: ID;
}

/** 分组框：带标题的区域，拖动时带着框内元素一起移动 */
export interface SectionElement extends ElementBase {
  type: "section";
  label: string;
}

export type CanvasElement = TextElement | ImageElement | FileElement | SectionElement;

export interface Edge {
  id: ID;
  fromId: ID;
  toId: ID;
  label?: string;
}

export interface Viewport {
  /** 世界坐标原点在屏幕上的偏移（像素） */
  x: number;
  y: number;
  zoom: number;
}

/** 画布的完整内容。磁盘上以 JSON Canvas 兼容格式保存，见 lib/jsonCanvas.ts */
export interface CanvasDoc {
  canvasId: ID;
  elements: CanvasElement[];
  edges: Edge[];
  viewport: Viewport;
}

export interface Asset {
  id: ID;
  /** 内容 SHA-256，用于去重 */
  hash: string;
  /** 相对工作区根目录的路径，使用 / 分隔 */
  path: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  importedAt: Timestamp;
  /** 图片中识别出的文字；null 表示尚未识别 */
  ocrText?: string | null;
  /** 引用该资源的画布数 */
  refCount: number;
}

/** 一次保存相对上次保存的变化量 */
export interface ChangeSummary {
  added: number;
  modified: number;
  removed: number;
}

/** 保存画布时随附的索引信息，供搜索与资源引用计数使用 */
export interface CanvasIndex {
  elementCount: number;
  texts: { elementId: ID; text: string }[];
  assetIds: ID[];
  preview: string;
}

/** 日历的一条记录：某画布在某天被编辑过，以及当天累计的变化量 */
export interface CanvasDay {
  canvasId: ID;
  date: LocalDate;
  changeCount: number;
}

export type SearchHitKind = "canvas" | "text" | "file" | "image";

export interface SearchHit {
  kind: SearchHitKind;
  canvasId: ID;
  canvasTitle: string;
  projectId: ID;
  elementId?: ID | null;
  /** 命中文件或图片时，用来在画布上找到对应卡片 */
  assetId?: ID | null;
  snippet: string;
}

export const PROJECT_COLORS = ["#2F5D50", "#C2410C", "#B45309", "#4D7C0F", "#0E7490", "#4338CA", "#9D174D"] as const;
