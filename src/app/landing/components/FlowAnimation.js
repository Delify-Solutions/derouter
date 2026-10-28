"use client";

// Static topology diagram: clients → router → providers. Built from bordered
// squares and 1px connectors, no animation and no SVG paths, so it stays legible
// at any width and never drifts. Desktop shows the three columns joined by
// horizontal rules; narrow screens stack them with a vertical connector.

const CLIENTS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cline", name: "Cline" },
  { id: "cursor", name: "Cursor" },
];

const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Gemini" },
  { id: "copilot", name: "GitHub Copilot" },
];

function Node({ children, emphasis = false }) {
  return (
    <div
      className={`flex h-11 items-center border px-3 font-mono text-[12px] ${
        emphasis
          ? "border-brand-500 bg-brand-500/5 text-text-main"
          : "border-border bg-surface text-text-muted"
      }`}
    >
      {children}
    </div>
  );
}

function Column({ title, items, emphasis = false }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="meta text-text-muted">{title}</p>
      {items.map((item) => (
        <Node key={item.id} emphasis={emphasis}>
          {item.name}
        </Node>
      ))}
    </div>
  );
}

export default function FlowAnimation() {
  return (
    <div className="mt-10 border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="meta text-text-muted">Request topology</span>
        <span className="font-mono text-[11px] text-text-subtle">POST /v1/chat/completions</span>
      </div>

      <div className="p-5">
        {/* Desktop: three columns joined by 1px rules. */}
        <div className="hidden md:grid md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center md:gap-0">
          <Column title="Clients" items={CLIENTS} />

          <div className="mx-4 flex flex-col items-center justify-center gap-1" aria-hidden="true">
            <span className="block h-px w-10 bg-border" />
            <span className="material-symbols-outlined text-[14px] text-text-subtle">arrow_forward</span>
          </div>

          <div className="flex flex-col gap-2">
            <p className="meta text-text-muted">Router</p>
            <div className="border border-brand-500 px-4 py-4">
              <p className="font-mono text-[13px] font-semibold text-text-main">derouter</p>
              <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px] text-text-muted">
                <li>resolve model</li>
                <li>charge credit</li>
                <li>log receipt</li>
              </ul>
            </div>
          </div>

          <div className="mx-4 flex flex-col items-center justify-center gap-1" aria-hidden="true">
            <span className="block h-px w-10 bg-border" />
            <span className="material-symbols-outlined text-[14px] text-text-subtle">arrow_forward</span>
          </div>

          <Column title="Providers" items={PROVIDERS} />
        </div>

        {/* Narrow: stacked, joined by a vertical 1px rule. */}
        <div className="flex flex-col md:hidden">
          <Column title="Clients" items={CLIENTS} />
          <div className="my-3 flex items-center gap-2" aria-hidden="true">
            <span className="block h-6 w-px bg-border" />
            <span className="material-symbols-outlined text-[14px] text-text-subtle">arrow_downward</span>
          </div>
          <div className="flex flex-col gap-2">
            <p className="meta text-text-muted">Router</p>
            <div className="border border-brand-500 px-4 py-4">
              <p className="font-mono text-[13px] font-semibold text-text-main">derouter</p>
              <p className="mt-1 font-mono text-[11px] text-text-muted">resolve · charge · log</p>
            </div>
          </div>
          <div className="my-3 flex items-center gap-2" aria-hidden="true">
            <span className="block h-6 w-px bg-border" />
            <span className="material-symbols-outlined text-[14px] text-text-subtle">arrow_downward</span>
          </div>
          <Column title="Providers" items={PROVIDERS} />
        </div>
      </div>
    </div>
  );
}
