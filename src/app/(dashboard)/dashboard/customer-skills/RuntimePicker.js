"use client";

import { useId, useState } from "react";
import { SKILL_RUNTIMES, toggleRuntime } from "@/lib/skills/runtimes.js";

// What "Chọn agent" starts from when the admin leaves "Mọi agent": the three most
// common, so the grid is never empty.
const STARTING_SUBSET = ["claude", "codex", "opencode"];

/**
 * Which agents a skill is for. The default is "Mọi agent" — a skill file is the same
 * markdown for every agent.
 *
 * `value` is `[]` for "every agent" and the chosen ids otherwise. "Every agent" is sent
 * as an empty list, never as the ids this page happens to know: a tab left open across
 * a deploy that adds an agent would otherwise save a subset and drop the new agent.
 * The mode is read from the value, so whoever sets it from outside (the bulk action)
 * keeps the radio in step.
 *
 * Used by the editor, both import reviews and the bulk "set agents" action.
 */
export default function RuntimePicker({ value, onChange, label = "Cài cho agent" }) {
  const [hint, setHint] = useState("");
  const name = useId();
  const narrow = value.length > 0;
  const selected = new Set(value);

  const setMode = (toNarrow) => {
    setHint("");
    onChange(toNarrow ? STARTING_SUBSET : []);
  };
  const toggle = (id) => {
    const result = toggleRuntime(value, id);
    setHint(result.changed ? "" : "Cần chọn ít nhất một agent.");
    if (result.changed) onChange(result.value);
  };

  const modeClass = (on) =>
    `flex h-9 cursor-pointer items-center gap-2 border px-3 text-sm transition-colors duration-150 ${
      on ? "border-text-main bg-surface-2 text-text-main" : "border-border bg-surface text-text-muted hover:text-text-main"
    }`;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        <label className={modeClass(!narrow)}>
          <input type="radio" name={name} checked={!narrow} onChange={() => setMode(false)} className="size-4" />
          Mọi agent
        </label>
        <label className={modeClass(narrow)}>
          <input type="radio" name={name} checked={narrow} onChange={() => setMode(true)} className="size-4" />
          Chọn agent
        </label>
      </div>
      {narrow ? (
        <div className="flex flex-wrap gap-2">
          {SKILL_RUNTIMES.map((runtime) => {
            const on = selected.has(runtime.id);
            return (
              <label key={runtime.id} className={modeClass(on)}>
                <input type="checkbox" checked={on} onChange={() => toggle(runtime.id)} className="size-4" />
                {runtime.label}
              </label>
            );
          })}
        </div>
      ) : (
        <p className="text-xs leading-5 text-text-muted">
          Khách cài vào bất kỳ agent nào máy họ có, kể cả agent được thêm về sau.
        </p>
      )}
      <p role="status" className="min-h-4 text-xs text-text-muted">{hint}</p>
    </fieldset>
  );
}
