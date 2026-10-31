// Markdown → sanitised HTML for operator-authored content.
//
// The landing page copy and the /docs pages are written by an admin, stored in
// the database, and rendered on a public page. That makes them attacker-adjacent
// input: not anonymous, but a compromised admin session or a paste from an
// untrusted source must not be able to inject script into every visitor.
//
// marked does not sanitise — raw HTML in the source passes straight through —
// so every string goes through sanitizeHtml here before it reaches
// dangerouslySetInnerHTML. Keeping this in one module (rather than in a client
// component) is what lets the server render the page without shipping marked to
// the browser.
import { Marked } from "marked";
import { splitTabBlocks } from "./docsTabs.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Images render as a figure whose caption is the alt text. Screenshots in the
// docs are added after the text is written, so a missing file must still leave a
// readable block (the caption says what the picture shows) instead of a broken
// icon wedged into the page. The <img> itself carries an empty alt because the
// caption already supplies the text; a screen reader reads it once.
// A private instance: the global `marked` is shared with other modules (the
// changelog modal), and the figure renderer must not change how they render.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, title, text }) {
      const caption = escapeHtml(text);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return (
        `<span class="docs-figure"><img src="${escapeHtml(href)}" alt="" loading="lazy"${titleAttr}>` +
        (caption ? `<span class="docs-figure-caption">${caption}</span>` : "") +
        `</span>`
      );
    },
  },
});

const BLOCKED_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet",
  "link", "meta", "style", "form", "base", "noscript", "template",
  // SVG/MathML carry their own scripting surface (SMIL can set href); docs never need them.
  "svg", "math", "animate", "animatetransform", "animatemotion", "set",
]);

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href", "srcdoc"]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "#"]);

// Matches one HTML tag, attribute values included, so the fallback below only
// ever rewrites markup and never the text between tags (a code block that
// mentions `onclick=` or `href=` is escaped text, not a tag).
const TAG_RE = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// Used when DOMParser is unavailable (server-side rendering, which is where
// /docs renders). Same vectors as the DOM walk: blocked tags are dropped, `on*`
// attributes are dropped, and a URL attribute is kept only when its scheme is
// allowed. Replacing every URL attribute with "#" here would be safe but would
// also kill every link and image on every docs page.
function sanitizeWithoutDom(html) {
  const blockedOpen = Array.from(BLOCKED_TAGS).join("|");
  const withoutBlocked = String(html)
    .replace(new RegExp(`<\\s*(${blockedOpen})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\s*/?\\s*(${blockedOpen})\\b[^>]*>`, "gi"), "");

  return withoutBlocked.replace(TAG_RE, (match, slash, name, attrs) => {
    if (slash) return match;
    let out = "";
    for (const m of attrs.matchAll(ATTR_RE)) {
      const attr = m[1];
      const value = m[2] ?? m[3] ?? m[4];
      const lower = attr.toLowerCase();
      if (lower.startsWith("on")) continue;
      if (value === undefined) {
        out += ` ${attr}`;
        continue;
      }
      const safe = URL_ATTRS.has(lower) && isDangerousUrl(decodeEntities(value)) ? "#" : value;
      out += ` ${attr}="${safe.replace(/"/g, "&quot;")}"`;
    }
    return `<${name}${out}>`;
  });
}

// Numeric and the few named entities are enough to unmask "java&#x73;cript:".
function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");
}

function isDangerousUrl(value) {
  // Browsers ignore control characters and whitespace when parsing a scheme, so
  // "java\tscript:" must be caught as well as "javascript:".
  const cleaned = String(value).replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (cleaned.startsWith("#")) return false;
  const match = /^([a-z][a-z0-9+.-]*):/.exec(cleaned);
  return Boolean(match) && !ALLOWED_PROTOCOLS.has(`${match[1]}:`);
}

export function sanitizeHtml(html) {
  if (!html) return "";

  if (typeof DOMParser === "undefined") {
    return sanitizeWithoutDom(html);
  }

  const doc = new DOMParser().parseFromString(String(html), "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (BLOCKED_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

// One tab group as plain HTML. Readable without scripts: every panel is visible
// under its own title and the tablist is hidden by CSS. The docs page enhances it
// (DocsTabsEnhancer) by revealing the tablist and hiding the inactive panels.
// Titles are escaped here and the whole result is sanitised by the caller.
function renderTabGroup(tabs, groupId) {
  if (tabs.length === 1) {
    return `<div class="docs-tab-single"><p class="docs-tab-title">${escapeHtml(tabs[0].title)}</p>${marked.parse(tabs[0].body)}</div>`;
  }
  const buttons = tabs
    .map((tab, i) =>
      `<button type="button" role="tab" id="${groupId}-tab-${i}" aria-controls="${groupId}-panel-${i}" ` +
      `aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}" data-tab-label="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</button>`
    )
    .join("");
  const panels = tabs
    .map((tab, i) =>
      `<div role="tabpanel" id="${groupId}-panel-${i}" aria-labelledby="${groupId}-tab-${i}" class="docs-tab-panel">` +
      `<p class="docs-tab-title">${escapeHtml(tab.title)}</p>${marked.parse(tab.body)}</div>`
    )
    .join("");
  return `<div class="docs-tabs"><div role="tablist" class="docs-tablist">${buttons}</div>${panels}</div>`;
}

/**
 * Markdown to sanitised HTML.
 * Empty input returns an empty string, not "<p></p>", so a caller can test for
 * presence without string surgery.
 *
 * Tab blocks (see docsTabs.js) are rendered to a tablist + panels. Sanitising
 * runs once over the composed output, so nothing a tab title or body contains
 * can bypass it.
 */
export function renderMarkdown(md) {
  const text = typeof md === "string" ? md.trim() : "";
  if (!text) return "";
  let group = 0;
  const html = splitTabBlocks(text)
    .map((segment) => (segment.type === "tabs"
      ? renderTabGroup(segment.tabs, `docs-tabs-${group++}`)
      : marked.parse(segment.text)))
    .join("");
  return sanitizeHtml(html);
}
