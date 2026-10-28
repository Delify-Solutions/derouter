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
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

const BLOCKED_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet",
  "link", "meta", "style", "form", "base", "noscript", "template",
]);

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href", "srcdoc"]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "#"]);

// Used when DOMParser is unavailable (server-side rendering). The same vectors
// as the DOM walk, expressed as regex — a belt-and-braces path, not the primary
// defence.
const FALLBACK_PATTERNS = [
  [/<\s*(script|iframe|object|embed|link|meta|style|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ""],
  [/<\s*(script|iframe|object|embed|link|meta|style|form|base)\b[^>]*\/?>/gi, ""],
  [/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""],
  [/\b(href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1="#"'],
];

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
    return FALLBACK_PATTERNS.reduce(
      (out, [pattern, replacement]) => out.replace(pattern, replacement),
      String(html)
    );
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

/**
 * Markdown to sanitised HTML.
 * Empty input returns an empty string, not "<p></p>", so a caller can test for
 * presence without string surgery.
 */
export function renderMarkdown(md) {
  const text = typeof md === "string" ? md.trim() : "";
  if (!text) return "";
  return sanitizeHtml(marked.parse(text));
}
