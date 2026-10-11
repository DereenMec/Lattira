/**
 * 链接卡片：识别网址、放到画布上、在后台获取网页标题和预览图。
 * 卡片先以网址的形式出现，获取到信息后再补上（不进撤销历史，见 canvasStore.patchQuietly）。
 */
import { create } from "zustand";
import { promptText } from "@/features/menu/PromptDialog";
import type { Point } from "@/lib/geometry";
import { uuidv7 } from "@/lib/id";
import { t } from "@/i18n";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useSettings } from "@/store/settingsStore";
import type { ID, LinkElement, LinkPreview } from "@/types/model";

export const LINK_WIDTH = 320;
/** 没有预览图时的高度：标题、简介、网站名 */
export const LINK_HEIGHT = 128;
/** 有预览图时，图片区域的高度（宽高比约 1.91:1，与常见的分享图一致） */
const LINK_IMAGE_HEIGHT = 168;
/** 一次粘贴最多变成多少张链接卡片，再多就当普通文本 */
const MAX_LINKS = 20;

/** 正在获取预览的链接卡片 */
export const useLinkFetching = create<{ ids: ReadonlySet<ID> }>(() => ({ ids: new Set() }));

const setFetching = (id: ID, on: boolean) =>
  useLinkFetching.setState((s) => {
    const ids = new Set(s.ids);
    if (on) ids.add(id);
    else ids.delete(id);
    return { ids };
  });

/** 一个合法的 http / https 网址；不是时返回 null */
export function asWebUrl(text: string): string | null {
  const s = text.trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** 文本的每个非空行都是网址时返回这些网址（用于粘贴），否则返回空数组 */
export function urlsInText(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0 || lines.length > MAX_LINKS) return [];
  const urls = lines.map(asWebUrl);
  return urls.every((u): u is string => u !== null) ? urls : [];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function newLinkCard(at: Point, url: string): LinkElement {
  const now = Date.now();
  return {
    id: uuidv7(),
    type: "link",
    url,
    x: at.x - LINK_WIDTH / 2,
    y: at.y - LINK_HEIGHT / 2,
    width: LINK_WIDTH,
    height: LINK_HEIGHT,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把网址作为链接卡片放到画布上，并在后台获取预览。
 * 多个时排成每行 4 张的网格，行距按带预览图的高度留，卡片拿到图片加高后不会互相盖住。
 */
export function placeLinks(urls: string[], at: Point, parentId?: ID): LinkElement[] {
  const gap = 24;
  const cols = Math.min(urls.length, 4);
  const left = at.x - ((cols - 1) * (LINK_WIDTH + gap)) / 2;
  const cards = urls.map((url, i) => {
    const card = newLinkCard(
      { x: left + (i % cols) * (LINK_WIDTH + gap), y: at.y + Math.floor(i / cols) * (LINK_HEIGHT + LINK_IMAGE_HEIGHT + gap) },
      url,
    );
    return parentId ? { ...card, parentId } : card;
  });
  useCanvasStore.getState().addElements(cards, { select: !parentId });
  if (useSettings.getState().linkPreviews) for (const card of cards) void fetchPreview(card);
  return cards;
}

/**
 * 获取网页信息并补到卡片上。刚放上来、还是默认高度的卡片，拿到预览图后会自动加高。
 * 获取失败时卡片保持只有网址的样子；manual 为 true（用户手动刷新）时提示原因。
 */
export async function fetchPreview(card: LinkElement, manual = false) {
  const canvasId = useCanvasStore.getState().doc?.canvasId;
  if (!canvasId || useLinkFetching.getState().ids.has(card.id)) return;
  setFetching(card.id, true);
  try {
    const p: LinkPreview = await backend.fetchLinkPreview(card.url);
    const current = useCanvasStore.getState().doc?.elements.find((e) => e.id === card.id);
    // 等待期间卡片被改成了别的网址：这次的结果作废
    if (current && (current.type !== "link" || current.url !== card.url)) return;
    const height = current?.height ?? card.height;
    const grow = !!p.image && height === LINK_HEIGHT;
    await useCanvasStore.getState().patchQuietly(canvasId, {
      [card.id]: {
        title: p.title ?? undefined,
        description: p.description ?? undefined,
        siteName: p.siteName ?? undefined,
        image: p.image ?? undefined,
        icon: p.icon ?? undefined,
        ...(grow ? { height: LINK_HEIGHT + LINK_IMAGE_HEIGHT } : {}),
      },
    });
  } catch (e) {
    if (manual) useAppStore.getState().showToast(t("获取链接预览失败：{error}", { error: String(e) }));
  } finally {
    setFetching(card.id, false);
  }
}

/** 用户输入的网址；省略 https:// 的（如 example.com/page）自动补上 */
export function parseTypedUrl(input: string): string | null {
  const s = input.trim();
  return asWebUrl(s) ?? (/^[^\s/]+\.[^\s/]+/.test(s) ? asWebUrl(`https://${s}`) : null);
}

/** 弹框输入网址，在 at 处放一张链接卡片 */
export async function promptLink(at: Point, parentId?: ID) {
  const input = await promptText(t("添加链接：输入网址"));
  if (input === null) return;
  const url = parseTypedUrl(input);
  if (!url) {
    useAppStore.getState().showToast(t("不是有效的网址：{url}", { url: input }));
    return;
  }
  const cards = placeLinks([url], at, parentId);
  if (parentId) useCanvasStore.getState().showInOpenFolder(parentId, cards.map((c) => c.id));
}

/** 弹框修改链接卡片的网址 */
export async function editLink(card: LinkElement) {
  const input = await promptText(t("修改网址"), card.url);
  if (input === null) return;
  const url = parseTypedUrl(input);
  if (!url) useAppStore.getState().showToast(t("不是有效的网址：{url}", { url: input }));
  else if (url !== card.url) changeUrl(card, url);
}

/** 修改链接卡片的网址：清掉旧网页的信息，重新获取 */
export function changeUrl(card: LinkElement, url: string) {
  const s = useCanvasStore.getState();
  s.updateElements({
    [card.id]: { url, title: undefined, description: undefined, siteName: undefined, image: undefined, icon: undefined },
  });
  if (useSettings.getState().linkPreviews) void fetchPreview({ ...card, url });
}

export async function openLink(url: string) {
  try {
    await backend.openUrl(url);
  } catch (e) {
    useAppStore.getState().showToast(t("无法打开链接：{error}", { error: String(e) }));
  }
}
