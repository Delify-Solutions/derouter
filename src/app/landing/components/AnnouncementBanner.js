import Link from "next/link";
import PropTypes from "prop-types";

// Announcement strip above the hero, the same device opencode.ai/go uses for
// "New … is now available". Server-rendered: it is static per request and has no
// interaction beyond the link.
//
// Hidden when the admin has cleared the text even if `bannerEnabled` is on —
// otherwise turning the switch on before writing the sentence would leave an
// empty coloured bar with no way to tell what went wrong.
export default function AnnouncementBanner({ text, href, enabled }) {
  const message = typeof text === "string" ? text.trim() : "";
  if (!enabled || !message) return null;

  const content = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span className="border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-700 dark:text-brand-400">
        Mới
      </span>
      <span className="text-sm text-text-muted">{message}</span>
    </span>
  );

  const className =
    "flex items-center justify-center border-b border-border bg-surface px-4 py-2.5 text-center";

  // An empty href makes the strip informational only rather than a dead link.
  const target = typeof href === "string" ? href.trim() : "";
  if (!target) {
    return <div className={className}>{content}</div>;
  }

  // External links leave the app; internal ones stay client-side.
  const isExternal = /^https?:\/\//i.test(target);
  if (isExternal) {
    return (
      <a href={target} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <Link href={target} className={className}>
      {content}
    </Link>
  );
}

AnnouncementBanner.propTypes = {
  text: PropTypes.string,
  href: PropTypes.string,
  enabled: PropTypes.bool,
};
