"use client";

const STEPS = [
  {
    number: "01",
    icon: "terminal",
    title: "Point a client at the endpoint",
    body:
      "Set the base URL to your derouter host with /v1 and paste an API key. Claude Code, Codex, Cline and Cursor all speak the same OpenAI wire format, so nothing else changes.",
  },
  {
    number: "02",
    icon: "alt_route",
    title: "The router resolves the model",
    body:
      "The model name you send maps to a combo: an ordered list of provider connections with fallback. The first healthy connection answers; the rest stay on standby.",
  },
  {
    number: "03",
    icon: "receipt_long",
    title: "The request is metered",
    body:
      "Tokens and cost are written to the request log as the stream finishes. The debit comes out of your credit balance, and the receipt is visible on the usage page.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <p className="meta text-text-muted">How it works</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          Three steps, all server side
        </h2>
        <p className="mt-3 max-w-2xl text-text-muted">
          The proxy sits between your client and the providers. It holds the credentials, so a key you hand out
          never carries a provider secret.
        </p>

        <ol className="mt-10 grid grid-cols-1 border border-border md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.number}
              className={`bg-surface p-6 ${index > 0 ? "border-t border-border md:border-l md:border-t-0" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="flex size-8 items-center justify-center border border-border text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">{step.icon}</span>
                </span>
                <span className="font-mono text-[11px] text-text-subtle">{step.number}</span>
              </div>
              <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
