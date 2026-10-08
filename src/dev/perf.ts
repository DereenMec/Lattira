/**
 * 大画布性能验证（仅开发模式）。在开发者工具控制台中运行：
 *
 *   await __lattiraPerf.run(1000)   // 生成 1000 张卡片的画布并测量
 *
 * 测量项：打开画布到首帧的时间、100% 缩放下连续平移、缩小到 25% 时连续平移的帧率。
 */
import { uuidv7 } from "@/lib/id";
import { toJsonCanvas } from "@/lib/jsonCanvas";
import { buildPreview } from "@/lib/preview";
import { backend } from "@/services/backend";
import { inboxOf, useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import { CARD_COLORS, type CanvasDoc, type CanvasElement, type Edge, type ID } from "@/types/model";

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

const SAMPLE_LINES = [
  "竞品分析：画布类工具的文件管理能力",
  "会议纪要 10 月 8 日\n- 确认 MVP 范围\n- 下周评审交互稿",
  "待办\n1. 整理参考资料\n2. 补充用户访谈记录\n3. 输出结论",
  "灵感：用日历回看每天整理过的资料，比文件夹更符合记忆方式。",
  "Reading list\nThe design of everyday things\nHow to take smart notes",
];

/** 生成一个 n 张卡片的网格画布，每 4 张卡片连一条线，每 50 张卡片一个分组框 */
export async function generate(n: number): Promise<ID> {
  const app = useAppStore.getState();
  const inbox = inboxOf(app.projects);
  if (!inbox) throw new Error("请先打开工作区");
  const meta = await backend.createCanvas(inbox.id, `性能测试 ${n} 张卡片`);
  const now = Date.now();
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const elements: CanvasElement[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    elements.push({
      id: uuidv7(),
      type: "text",
      text: `#${i + 1} ${SAMPLE_LINES[i % SAMPLE_LINES.length]}`,
      x: col * 320,
      y: row * 200,
      width: 280,
      height: 150,
      color: CARD_COLORS[i % CARD_COLORS.length],
      createdAt: now,
      updatedAt: now,
    });
    if (i % 4 === 1) edges.push({ id: uuidv7(), fromId: elements[i - 1].id, toId: elements[i].id });
  }
  for (let start = 0; start < n; start += 50) {
    const first = elements[start];
    elements.unshift({
      id: uuidv7(),
      type: "section",
      label: `分组 ${start / 50 + 1}`,
      x: first.x - 16,
      y: first.y - 40,
      width: 312,
      height: 190,
      createdAt: now,
      updatedAt: now,
    });
  }
  const doc: CanvasDoc = { canvasId: meta.id, elements, edges, viewport: { x: 40, y: 40, zoom: 1 } };
  const saved = await backend.saveCanvas(
    meta.id,
    toJsonCanvas(doc, new Map()),
    {
      elementCount: elements.length,
      texts: elements.flatMap((e) => (e.type === "text" ? [{ elementId: e.id, text: e.text }] : [])),
      assetIds: [],
      preview: buildPreview(doc, new Map()),
    },
    { added: elements.length + edges.length, modified: 0, removed: 0 },
  );
  useAppStore.setState((s) => ({ canvases: [...s.canvases, saved] }));
  return meta.id;
}

interface FrameStats {
  fps: number;
  p95FrameMs: number;
  slowFrames: number;
  renderedElements: number;
}

/** 以每帧 step 像素的速度连续平移 durationMs，统计帧率 */
async function measurePan(durationMs: number, zoom: number, step = 12): Promise<FrameStats> {
  const store = useCanvasStore.getState();
  store.setViewport({ x: 40, y: 40, zoom });
  await nextFrame();
  await nextFrame();
  const frames: number[] = [];
  let last = await nextFrame();
  const start = last;
  let vp = useCanvasStore.getState().viewport;
  while (last - start < durationMs) {
    vp = { ...vp, x: vp.x - step, y: vp.y - step * 0.4 };
    useCanvasStore.getState().setViewport(vp);
    const t = await nextFrame();
    frames.push(t - last);
    last = t;
  }
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    fps: Math.round((frames.length / (last - start)) * 1000),
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
    slowFrames: frames.filter((f) => f > 20).length,
    renderedElements: document.querySelectorAll(".canvas-world .el").length,
  };
}

const channel = new MessageChannel();
/** 让出主线程一次；不受后台标签页对定时器和 rAF 的节流影响 */
const yieldTask = () =>
  new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

interface WorkStats {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  renderedElements: number;
}

/**
 * 每次平移的主线程耗时：更新视口 → React 渲染 → 强制样式与布局计算。
 * 不含合成与绘制（由 GPU 完成）；低于 16.7ms 说明一帧内做得完。
 */
async function measureWork(steps: number, zoom: number): Promise<WorkStats> {
  // 以内容中心为圆心、半径 400px 绕圈平移，始终停留在内容范围内
  const els = useCanvasStore.getState().doc!.elements;
  const cx = els.reduce((s, e) => s + e.x + e.width / 2, 0) / els.length;
  const cy = els.reduce((s, e) => s + e.y + e.height / 2, 0) / els.length;
  const root = document.querySelector<HTMLElement>(".canvas-root")!.getBoundingClientRect();
  const base = { x: root.width / 2 - cx * zoom, y: root.height / 2 - cy * zoom };
  useCanvasStore.getState().setViewport({ ...base, zoom });
  await yieldTask();
  const world = document.querySelector<HTMLElement>(".canvas-world")!;
  const costs: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / 120) * Math.PI * 2;
    const vp = { x: base.x + Math.cos(a) * 400, y: base.y + Math.sin(a) * 400, zoom };
    const t0 = performance.now();
    useCanvasStore.getState().setViewport(vp);
    await yieldTask();
    void world.getBoundingClientRect();
    void document.querySelector<HTMLElement>(".canvas-world .el:last-child")?.offsetHeight;
    costs.push(performance.now() - t0);
  }
  const sorted = [...costs].sort((a, b) => a - b);
  const pick = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
  return {
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
    renderedElements: document.querySelectorAll(".canvas-world .el").length,
  };
}

/** 页面不可见时浏览器会把 rAF 降到每秒 1 次，此时只看主线程耗时 */
export async function runWork(n = 1000) {
  const id = await generate(n);
  const t0 = performance.now();
  useAppStore.getState().navigate({ kind: "canvas", canvasId: id });
  while (useCanvasStore.getState().doc?.canvasId !== id || document.querySelectorAll(".canvas-world .el").length === 0) {
    await yieldTask();
  }
  const openMs = Math.round(performance.now() - t0);
  const work100 = await measureWork(240, 1);
  const work25 = await measureWork(240, 0.25);
  const work10 = await measureWork(240, 0.1);
  return { cards: n, openMs, work100, work25, work10 };
}

export async function run(n = 1000) {
  const id = await generate(n);
  const t0 = performance.now();
  useAppStore.getState().navigate({ kind: "canvas", canvasId: id });
  while (document.querySelectorAll(".canvas-world .el").length === 0) await nextFrame();
  await nextFrame();
  const openMs = Math.round(performance.now() - t0);

  const pan100 = await measurePan(3000, 1);
  const pan25 = await measurePan(3000, 0.25, 30);
  const result = { cards: n, openMs, pan100, pan25 };
  console.table({ "100% 平移": pan100, "25% 平移": pan25 });
  console.log(`打开画布：${openMs} ms`);
  return result;
}

declare global {
  interface Window {
    __lattiraPerf?: { run: typeof run; runWork: typeof runWork; generate: typeof generate };
  }
}

window.__lattiraPerf = { run, runWork, generate };
