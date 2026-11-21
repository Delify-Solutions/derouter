"use client";

// "Model: Khách gọi | Gốc" (spec admin-usage-views "Model view switch"): whether the usage
// Overview and Details group by the model the client asked for (a combo name) or by the
// upstream model that answered. Kept in the `modelView` URL parameter; anything other than
// "upstream" means the requested view.

import { useCallback, useId } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/shared/utils/cn";

export const MODEL_VIEW_OPTIONS = [
  { value: "requested", label: "Khách gọi" },
  { value: "upstream", label: "Gốc" },
];

export function parseModelView(value) {
  return value === "upstream" ? "upstream" : "requested";
}

/** [modelView, setModelView] bound to the `modelView` URL parameter. */
export function useModelView() {
  const searchParams = useSearchParams();
  const modelView = parseModelView(searchParams.get("modelView"));
  const setModelView = useCallback((value) => {
    const params = new URLSearchParams(window.location.search);
    params.set("modelView", parseModelView(value));
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, []);
  return [modelView, setModelView];
}

export default function ModelViewSwitch({ value, onChange, className }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={cn("inline-flex items-center gap-2", className)}>
      <span id={labelId} className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Model:</span>
      <div className="inline-flex border border-border">
        {MODEL_VIEW_OPTIONS.map((o, i) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={cn(
                "h-8 px-3 font-mono text-xs font-semibold uppercase tracking-wider transition-colors duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
                i > 0 && "border-l border-border",
                // brand-600 keeps white text above 4.5:1 in both themes.
                active ? "bg-brand-600 text-white" : "bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              {active && <span className="material-symbols-outlined mr-1 align-[-3px] text-[14px]" aria-hidden="true">check</span>}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
