import { useLayoutEffect, type RefObject } from "react";

export function useDialog(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const items = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const available = items();
      if (!available.length) { event.preventDefault(); root.focus(); return; }
      const at = available.indexOf(document.activeElement as HTMLElement);
      if (at < 0 || (event.shiftKey ? at === 0 : at === available.length - 1)) {
        event.preventDefault(); (event.shiftKey ? available.at(-1) : available[0])?.focus();
      }
    };
    root.addEventListener("keydown", key);
    const focus = (event: FocusEvent) => {
      // A newer stacked dialog owns focus until it closes.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] === root && !root.contains(event.target as Node)) items()[0]?.focus();
    };
    document.addEventListener("focusin", focus);
    items()[0]?.focus();
    return () => { root.removeEventListener("keydown", key); document.removeEventListener("focusin", focus); if (previous?.isConnected) previous.focus(); };
  }, [open, ref]);
}
