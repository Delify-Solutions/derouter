"use client";

import Link from "next/link";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";
const REPO_URL = "https://github.com/Delify-Solutions/derouter";
const LICENSE_URL = "https://github.com/Delify-Solutions/derouter/blob/main/LICENSE";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "#product", label: "What it does" },
      { href: "#how-it-works", label: "How it works" },
      { href: "#features", label: "Features" },
      { href: "#get-started", label: "Get started" },
    ],
  },
  {
    title: "Account",
    links: [
      { href: "/register", label: "Create account" },
      { href: "/login", label: "Sign in" },
      { href: "/register?next=/account/plans", label: "Pricing" },
      { href: "/usage", label: "Usage lookup" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: DOCS_URL, label: "README", external: true },
      { href: REPO_URL, label: "Repository", external: true },
      { href: LICENSE_URL, label: "MIT license", external: true },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="bg-bg">
      <div className="shell py-14">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center border border-border text-text-main">
                <span className="material-symbols-outlined text-[18px]">hub</span>
              </span>
              <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em]">derouter</span>
            </div>
            <p className="mt-4 max-w-xs text-sm text-text-muted">
              A hosted proxy for AI providers, with per-key usage metering and prepaid credit.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <p className="meta text-text-muted">{column.title}</p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={`${column.title}-${link.label}`}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-text-muted transition-colors duration-150 hover:text-text-main"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-text-muted transition-colors duration-150 hover:text-text-main"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle">
            © {new Date().getFullYear()} derouter
          </p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle transition-colors duration-150 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[14px]">code</span>
            Delify-Solutions/derouter
          </a>
        </div>
      </div>
    </footer>
  );
}
