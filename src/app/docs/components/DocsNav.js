"use client";

import { useState } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import ThemeToggle from "@/shared/components/ThemeToggle";

// Docs navigation, modelled on opencode.ai/v2/docs: sections across the top,
// pages for the active section down the side.
//
// Sections come from the database (derived from the pages themselves), so an
// admin who types a new section name gets a new tab without a code change.
export default function DocsNav({ groups, activeSlug }) {
  // The section of the page being read decides the initial tab; when reading the
  // index there is no page, so the first section opens.
  const initial = groups.find((g) => g.pages.some((p) => p.slug === activeSlug))?.section
    ?? groups[0]?.section
    ?? null;
  const [activeSection, setActiveSection] = useState(initial);

  if (!groups.length) return null;

  const current = groups.find((g) => g.section === activeSection) ?? groups[0];

  return (
    <header className="border-b border-border">
      <div className="shell flex items-center justify-between py-4">
        <Link href="/" className="font-mono text-sm font-semibold uppercase tracking-[0.12em]">
          derouter
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle variant="square" className="size-8" />
          <Link
            href="/"
            className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-main transition-colors hover:bg-surface-2"
          >
            Trang chủ
          </Link>
        </div>
      </div>

      {/* Section rail. Horizontal scroll rather than wrapping: five or six
          sections fit, and wrapping would push the page content down. */}
      <div className="shell overflow-x-auto">
        <nav aria-label="Nhóm tài liệu" className="flex min-w-max items-center gap-1 border-t border-border pt-1">
          {groups.map((group) => {
            const isActive = group.section === current.section;
            return (
              <button
                key={group.section}
                type="button"
                aria-current={isActive ? "true" : undefined}
                onClick={() => setActiveSection(group.section)}
                className={`h-10 px-4 font-mono text-[12px] uppercase tracking-[0.08em] transition-colors ${
                  isActive
                    ? "border-b-2 border-brand-500 text-text-main"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {group.section}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Page list for the active section, shown on the index page only. The
          detail page renders its own sidebar next to the article. */}
      <div className="shell border-t border-border py-2 md:hidden">
        <nav aria-label="Trang trong nhóm" className="flex flex-wrap gap-x-4 gap-y-1">
          {current.pages.map((page) => (
            <Link
              key={page.id}
              href={`/docs/${page.slug}`}
              className={`font-mono text-[11px] uppercase tracking-[0.06em] ${
                page.slug === activeSlug ? "text-brand-700 dark:text-brand-400" : "text-text-muted"
              }`}
            >
              {page.title}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

DocsNav.propTypes = {
  groups: PropTypes.array.isRequired,
  activeSlug: PropTypes.string,
};
