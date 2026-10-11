/**
 * 发现被外部程序改过的文件（例如从画布上双击打开、用记事本改完保存）。
 *
 * 窗口重新获得焦点（从记事本等程序切回来）或打开画布时检查一次，更新登记的大小、指纹和图片尺寸，
 * 卡片上的文件大小和图片随之刷新。检查只读文件属性，没改过的文件不会重新读取内容。
 * 从画布上打开的文件是这个画布自己的那份（见 assetEditing.ts），改动不会影响其他画布。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { ID } from "@/types/model";

/** 短时间内（例如 focus 和 visibilitychange 同时触发）只检查一次 */
const MIN_INTERVAL = 800;

let running = false;
let lastRun = 0;

/** 当前画布（包括文件夹里）引用的文件 */
function currentAssetIds(): ID[] {
  const ids = new Set<ID>();
  for (const el of useCanvasStore.getState().doc?.elements ?? []) if ("assetId" in el) ids.add(el.assetId);
  return [...ids];
}

export async function checkAssetChanges(): Promise<void> {
  if (running || Date.now() - lastRun < MIN_INTERVAL || useAppStore.getState().status !== "ready") return;
  running = true;
  lastRun = Date.now();
  try {
    const changed = await backend.checkAssetChanges(currentAssetIds());
    if (changed.length) useAppStore.getState().addAssets(changed);
  } catch (e) {
    // 只是后台检查，失败时不打扰用户，下次切回窗口时再试
    console.warn("[assetChanges] 检查文件变化失败", e);
  } finally {
    running = false;
  }
}

/** 开始监听：窗口获得焦点、页面重新可见、切换到另一张画布时检查。返回停止监听的函数 */
export function watchAssetChanges(): () => void {
  const check = () => void checkAssetChanges();
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", onVisible);
  const stopCanvas = useCanvasStore.subscribe((s, prev) => {
    if (s.doc && s.doc.canvasId !== prev.doc?.canvasId) check();
  });
  // 桌面端：从托盘或任务栏切回窗口时 WebView 不一定收到 focus 事件，再听一下窗口本身的焦点变化
  let stopWindow: (() => void) | undefined;
  let disposed = false;
  if (backend.kind === "tauri") {
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => focused && check())
      .then((fn) => (disposed ? fn() : (stopWindow = fn)))
      .catch(() => {});
  }
  return () => {
    disposed = true;
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", onVisible);
    stopCanvas();
    stopWindow?.();
  };
}
