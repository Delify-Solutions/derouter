"use client";

import Link from "next/link";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";

const STEPS = [
  {
    number: "01",
    title: "Create an account",
    body: "Register with an email address, confirm the link that arrives, then sign in to the account area.",
  },
  {
    number: "02",
    title: "Add credit and a key",
    body: "Buy a credit plan and create an API key. The key is shown once, so store it where your client can read it.",
  },
  {
    number: "03",
    title: "Send your first request",
    body: "Set the base URL to your derouter host plus /v1 and use the key as the bearer token. Usage appears on the usage page.",
  },
];

export default function GetStarted() {
  const { copied, copy } = useCopyToClipboard();

  const snippet = [
    "curl $DEROUTER_BASE/v1/chat/completions \\",
    '  -H "Authorization: Bearer $DEROUTER_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"model":"<model>","messages":[{"role":"user","content":"hello"}]}\'',
  ].join("\n");

  return (
    <section id="get-started" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <p className="meta text-text-muted">Get started</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          An account, a key, one request
        </h2>
        <p className="mt-3 max-w-2xl text-text-muted">
          derouter is a hosted proxy. There is nothing to install: you register, buy credit, and issue keys.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          <ol className="flex flex-col border border-border bg-surface">
            {STEPS.map((step, index) => (
              <li
                key={step.number}
                className={`flex gap-4 p-5 ${index > 0 ? "border-t border-border" : ""}`}
              >
                <span className="mt-0.5 font-mono text-[12px] text-text-subtle">{step.number}</span>
                <div>
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-sm text-text-muted">{step.body}</p>
                </div>
              </li>
            ))}
            <div className="border-t border-border p-5 flex flex-col gap-2 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex h-10 flex-1 items-center justify-center border border-brand-500 bg-brand-500 px-5 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors duration-150 hover:border-brand-600 hover:bg-brand-600"
              >
                Create account
              </Link>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 flex-1 items-center justify-center border border-border px-5 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-text-main transition-colors duration-150 hover:bg-surface-2"
              >
                Read the docs
              </a>
            </div>
          </ol>

          <div className="border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="meta text-text-muted">Request</span>
              <button
                type="button"
                onClick={() => copy(snippet, "snippet")}
                className="inline-flex h-7 items-center gap-1.5 border border-border px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted transition-colors duration-150 hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {copied === "snippet" ? "check" : "content_copy"}
                </span>
                {copied === "snippet" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-text-main">
              {snippet}
            </pre>
            <p className="border-t border-border px-4 py-3 font-mono text-[11px] text-text-subtle">
              DEROUTER_BASE is your deployment origin, for example https://proxy.example.com
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
