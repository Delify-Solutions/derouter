"use client";

import { useState } from "react";

// A `$ command` box with a copy control. The label is for assistive tech: the
// icon alone is ambiguous.
export default function CopyBlock({ value, prompt = "$", label = "Sao chép" }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context); the text stays selectable.
    }
  };

  return (
    <div className="flex items-center gap-3 border border-border bg-surface-2 px-4 py-3">
      <span className="select-none font-mono text-sm text-text-subtle" aria-hidden="true">{prompt}</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-text-main">{value}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Đã sao chép" : label}
        className="flex size-8 shrink-0 items-center justify-center text-text-muted transition-colors duration-150 hover:text-text-main"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          {copied ? "check" : "content_copy"}
        </span>
      </button>
    </div>
  );
}
