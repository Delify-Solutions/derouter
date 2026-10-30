"use client";

import { useRef } from "react";

const TABS = [
  { id: "active", label: "Đang hoạt động" },
  { id: "inactive", label: "Không hoạt động" },
];

/**
 * Two-tab switch (WAI-ARIA tabs, manual activation off: arrow keys move and select).
 * The panel itself is rendered by the caller, keyed by the same ids.
 */
export default function PlanTabs({ tab, onTab, counts = {} }) {
  const refs = useRef({});

  const onKeyDown = (event) => {
    const index = TABS.findIndex((item) => item.id === tab);
    let next = null;
    if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
    else if (event.key === "ArrowLeft") next = TABS[(index - 1 + TABS.length) % TABS.length];
    else if (event.key === "Home") next = TABS[0];
    else if (event.key === "End") next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    onTab(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div role="tablist" aria-label="Trạng thái gói" className="flex border-b border-border" onKeyDown={onKeyDown}>
      {TABS.map((item) => {
        const selected = item.id === tab;
        return (
          <button
            key={item.id}
            ref={(node) => { refs.current[item.id] = node; }}
            type="button"
            role="tab"
            id={`plans-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`plans-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onTab(item.id)}
            className={`-mb-px flex h-11 items-center gap-2 border-b-2 px-4 font-mono text-[13px] font-medium transition-colors duration-150 ${
              selected
                ? "border-text-main text-text-main"
                : "border-transparent text-text-muted hover:text-text-main"
            }`}
          >
            {item.label}
            <span className="border border-border px-1.5 font-mono text-[11px] text-text-muted">
              {counts[item.id] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
