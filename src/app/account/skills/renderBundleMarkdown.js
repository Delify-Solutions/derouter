"use client";

// A bundle's description and usage guide are Markdown written by the admin, often
// prefilled from a third-party repository's README at import time — so, like the
// changelog modal, it is rendered client-side and sanitised before
// dangerouslySetInnerHTML: `marked` does not sanitise, and this text is not fully
// trusted just because an admin clicked "import".
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: true });

const BLOCKED_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet",
  "link", "meta", "style", "form", "base", "noscript", "template",
]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href", "srcdoc"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const FALLBACK_PATTERNS = [
  [/<\s*(script|iframe|object|embed|link|meta|style|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ""],
  [/<\s*(script|iframe|object|embed|link|meta|style|form|base)\b[^>]*\/?>/gi, ""],
  [/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""],
  [/\b(href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1="#"'],
];

function isDangerousUrl(value) {
  const cleaned = String(value).replace(/[\u0000- ]/g, "").toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*):/.exec(cleaned);
  return Boolean(match) && !ALLOWED_PROTOCOLS.has(`${match[1]}:`);
}

function sanitizeHtml(html) {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return FALLBACK_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(html));
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

/** Markdown to sanitised HTML, or "" for empty input. */
export function renderBundleMarkdown(md) {
  const text = typeof md === "string" ? md.trim() : "";
  if (!text) return "";
  return sanitizeHtml(marked.parse(text));
}
