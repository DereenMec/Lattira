import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useT } from "@/i18n";

interface PromptOptions {
  /** 只选中扩展名之前的部分（输入文件名时），与资源管理器重命名一致 */
  selectStem?: boolean;
  /** 标题下面的说明文字 */
  message?: string;
  /** 检查输入：有问题时返回提示文字（显示在输入框下方，不能确定），没问题时返回 null */
  validate?(value: string): string | null;
  /** 取消按钮的文字，默认「取消」 */
  cancelLabel?: string;
}

interface PromptState {
  prompt: { title: string; initial: string; opts: PromptOptions; resolve(v: string | null): void } | null;
}

const usePrompt = create<PromptState>(() => ({ prompt: null }));

/** 弹出单行输入框（用于重命名等）；取消时返回 null */
export function promptText(title: string, initial = "", opts: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ prompt: { title, initial, opts, resolve } }));
}

export function PromptHost() {
  const prompt = usePrompt((s) => s.prompt);
  const t = useT();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // 打开后、输入框里已经是初始文字时选中一次
  const needSelect = useRef(false);

  useEffect(() => {
    if (!prompt) return;
    setValue(prompt.initial);
    needSelect.current = true;
  }, [prompt]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!prompt || !input || !needSelect.current || value !== prompt.initial) return;
    needSelect.current = false;
    input.focus();
    const dot = value.lastIndexOf(".");
    if (prompt.opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [prompt, value]);

  if (!prompt) return null;
  const error = value.trim() ? (prompt.opts.validate?.(value.trim()) ?? null) : null;
  const finish = (v: string | null) => {
    if (v !== null && error) return;
    usePrompt.setState({ prompt: null });
    prompt.resolve(v === null ? null : v.trim() || null);
  };

  return (
    <div className="overlay" onPointerDown={() => finish(null)}>
      <div className="dialog prompt-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>{prompt.title}</h3>
        {prompt.opts.message && <p className="prompt-message">{prompt.opts.message}</p>}
        <input
          ref={inputRef}
          value={value}
          aria-invalid={!!error}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(value);
            if (e.key === "Escape") finish(null);
          }}
        />
        {error && <p className="prompt-error">{error}</p>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => finish(null)}>
            {prompt.opts.cancelLabel ?? t("取消")}
          </button>
          <button className="btn primary" disabled={!!error} onClick={() => finish(value)}>
            {t("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
