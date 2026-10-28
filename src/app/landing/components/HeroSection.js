"use client";

import Link from "next/link";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";

const SPECS = [
  { label: "Base URL", value: "/v1" },
  { label: "Wire format", value: "OpenAI compatible" },
  { label: "Billing", value: "Prepaid credit" },
];

export default function HeroSection() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Blueprint grid, masked so it fades before it reaches the copy. */}
      <div
        className="hero-blueprint-grid blueprint-fade absolute inset-0 pointer-events-none"
        aria-hidden="true"
      />

      <div className="shell relative py-20 md:py-28">
        <div className="max-w-3xl">
          <p className="meta text-text-muted">Hosted AI proxy</p>

          <h1 className="mt-4 text-4xl font-semibold leading-[1.15] tracking-tight md:text-6xl">
            One endpoint for every AI provider
          </h1>

          <p className="mt-6 max-w-2xl text-base text-text-muted md:text-lg">
            Point any OpenAI-compatible client at a single base URL. derouter resolves the model you ask for to a
            provider connection, streams the response back, and meters every request against your balance.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex h-12 items-center justify-center border border-brand-500 bg-brand-500 px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
            >
              Create account
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center gap-2 border border-border px-7 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-main transition-colors duration-150 hover:bg-surface-2"
            >
              <span className="material-symbols-outlined text-[18px]">description</span>
              Read the docs
            </a>
          </div>
        </div>

        <dl className="mt-12 grid grid-cols-1 border border-border sm:grid-cols-3">
          {SPECS.map((spec, index) => (
            <div
              key={spec.label}
              className={`px-5 py-4 ${index > 0 ? "border-t border-border sm:border-l sm:border-t-0" : ""}`}
            >
              <dt className="meta text-text-muted">{spec.label}</dt>
              <dd className="mt-1 font-mono text-sm text-text-main">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
