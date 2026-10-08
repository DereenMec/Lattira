import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useT } from "@/i18n";

interface PromptState {
  prompt: { title: string; initial: string; resolve(v: string | null): void } | null;
}

const usePrompt = create<PromptState>(() => ({ prompt: null }));

/** 弹出单行输入框（用于重命名等）；取消时返回 null */
export function promptText(title: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ prompt: { title, initial, resolve } }));
}

export function PromptHost() {
  const prompt = usePrompt((s) => s.prompt);
  const t = useT();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setValue(prompt.initial);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [prompt]);

  if (!prompt) return null;
  const finish = (v: string | null) => {
    usePrompt.setState({ prompt: null });
    prompt.resolve(v === null ? null : v.trim() || null);
  };

  return (
    <div className="overlay" onPointerDown={() => finish(null)}>
      <div className="dialog prompt-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>{prompt.title}</h3>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(value);
            if (e.key === "Escape") finish(null);
          }}
        />
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => finish(null)}>
            {t("取消")}
          </button>
          <button className="btn primary" onClick={() => finish(value)}>
            {t("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
