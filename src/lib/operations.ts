let generation = 0;
let context = () => ({ workspace: undefined as string | undefined, canvasId: undefined as string | undefined, active: false, hasFolder: (_id: string) => false });
export function bindOperationContext(reader: typeof context) { context = reader; }
export const invalidateOperations = () => { generation++; };
/** Async work is tied to both the workspace and the canvas where it began. */
export function operationTarget(parentId?: string) {
  const epoch = generation;
  const { workspace, canvasId } = context();
  return {
    canvasId,
    valid: () => epoch === generation && workspace === context().workspace && canvasId === context().canvasId && context().active && (!parentId || context().hasFolder(parentId)),
  };
}

const editors = new Set<() => void>();
export function registerEditor(commit: () => void) {
  editors.add(commit);
  return () => { editors.delete(commit); };
}
export function commitEditors() { for (const commit of [...editors]) commit(); }
export const modalOpen = () => !!document.querySelector('[role="dialog"], .overlay, .ctx-menu');

export async function contentHash(content: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
