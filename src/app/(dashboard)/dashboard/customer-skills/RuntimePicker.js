"use client";

import { useState } from "react";
import { SKILL_RUNTIMES, toggleRuntime } from "@/lib/skills/runtimes.js";

/**
 * Which agents a skill is for: one checkbox per runtime, at least one kept on.
 * Used by the editor, the import review and the bulk "set agents" action.
 */
export default function RuntimePicker({ value, onChange, label = "Cài cho agent" }) {
  const [hint, setHint] = useState("");
  const selected = new Set(value);
  const toggle = (id) => {
    const result = toggleRuntime(value, id);
    setHint(result.changed ? "" : "Cần chọn ít nhất một agent.");
    if (result.changed) onChange(result.value);
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {SKILL_RUNTIMES.map((runtime) => {
          const on = selected.has(runtime.id);
          return (
            <label
              key={runtime.id}
              className={`flex h-9 cursor-pointer items-center gap-2 border px-3 text-sm transition-colors duration-150 ${
                on ? "border-text-main bg-surface-2 text-text-main" : "border-border bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(runtime.id)} className="size-4" />
              {runtime.label}
            </label>
          );
        })}
      </div>
      <p role="status" className="min-h-4 text-xs text-text-muted">{hint}</p>
    </fieldset>
  );
}
