"use client";

// Feature grid. Claims here are limited to what the codebase actually does:
// combos with fallback (open-sse/services/combo.js), per-key limits
// (keyEnforcement.js), request logging (usageHistory), and prepaid credit.
const FEATURES = [
  {
    icon: "alt_route",
    title: "Combo fallback",
    body: "A model name maps to an ordered list of connections. When one fails or times out the next connection takes the request.",
  },
  {
    icon: "speed",
    title: "Per-key limits",
    body: "Each key can carry its own RPM, TPM, budget and reset window, and can only narrow what its group already allows.",
  },
  {
    icon: "model_training",
    title: "Model allow-lists",
    body: "Restrict a key to named models. Anything outside the list is rejected before a provider is contacted.",
  },
  {
    icon: "receipt_long",
    title: "Request receipts",
    body: "Every request logs its model, status, latency, token counts and cost. You can read the log from the usage page.",
  },
  {
    icon: "shield",
    title: "Provider credentials stay server side",
    body: "OAuth tokens and API keys live in the local database. A client sees only the derouter key it was given.",
  },
  {
    icon: "payments",
    title: "Prepaid credit",
    body: "Accounts spend from a credit balance that decreases with each request. A balance at zero stops the next call.",
  },
];

export default function Features() {
  return (
    <section id="features" className="border-b border-border">
      <div className="shell py-20">
        <p className="meta text-text-muted">Features</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          What the proxy handles for you
        </h2>

        {/* Outer top/left rule plus one right/bottom rule per cell: squares share
            hairlines at every breakpoint instead of doubling them. */}
        <div className="mt-10 grid grid-cols-1 border-t border-l border-border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="p-6 border-r border-b border-border">
              <span className="flex size-8 items-center justify-center border border-border text-text-muted">
                <span className="material-symbols-outlined text-[18px]">{feature.icon}</span>
              </span>
              <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-text-muted">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
