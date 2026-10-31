// Tab blocks inside docs Markdown.
//
// Authoring syntax (directive lines start at column 0):
//
//   :::tabs
//   ::tab[CC Switch]
//   ...markdown...
//   ::tab[Thủ công]
//   ...markdown...
//   :::
//
// Lines that look like directives inside a fenced code block are code, not
// directives, so a snippet may contain ":::" or "::tab[...]" safely. A missing
// closing ":::" ends the block at the end of the document. Blocks do not nest.
//
// This module only splits the text; rendering (and sanitising) stays in
// markdown.js so tab titles and bodies go through the same pipeline as any other
// content.

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TAB_RE = /^::tab\[(.*)\]\s*$/;

/** Tracks whether the scanner is inside a fenced code block. */
function createFenceTracker() {
  let open = null; // { char, length }
  return function isInsideAfter(line) {
    const match = FENCE_RE.exec(line);
    if (!match) return open !== null;
    const marker = match[1];
    if (!open) {
      // A backtick fence's info string may not contain a backtick.
      if (marker[0] === "`" && match[2].includes("`")) return false;
      open = { char: marker[0], length: marker.length };
      return true;
    }
    if (marker[0] === open.char && marker.length >= open.length && match[2].trim() === "") {
      open = null;
      return false;
    }
    return true;
  };
}

/**
 * Split Markdown into plain segments and tab groups.
 *
 * @param {string} text
 * @returns {Array<{ type: "md", text: string } | { type: "tabs", tabs: Array<{ title: string, body: string }> }>}
 */
export function splitTabBlocks(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const segments = [];
  let plain = [];
  let group = null; // { preamble: string[], tabs: [{ title, lines }] }
  const advance = createFenceTracker();

  const flushPlain = () => {
    if (plain.length) segments.push({ type: "md", text: plain.join("\n") });
    plain = [];
  };
  const flushGroup = () => {
    if (!group) return;
    if (group.tabs.length === 0) {
      // ":::tabs" with no ::tab inside: keep the content as ordinary Markdown.
      plain.push(...group.preamble);
    } else {
      if (group.preamble.some((l) => l.trim())) plain.push(...group.preamble);
      flushPlain();
      segments.push({
        type: "tabs",
        tabs: group.tabs.map((tab) => ({ title: tab.title, body: tab.lines.join("\n").trim() })),
      });
    }
    group = null;
  };

  for (const line of lines) {
    // True while this line is inside (or is the marker of) a fenced block. A marker
    // line never matches a directive, so no special case is needed for it.
    const inFence = advance(line);

    if (!inFence) {
      if (!group && /^:::tabs\s*$/.test(line)) {
        flushPlain();
        group = { preamble: [], tabs: [] };
        continue;
      }
      if (group && /^:::\s*$/.test(line)) {
        flushGroup();
        continue;
      }
      if (group) {
        const tab = TAB_RE.exec(line);
        if (tab) {
          group.tabs.push({ title: tab[1].trim(), lines: [] });
          continue;
        }
      }
    }

    if (group) {
      if (group.tabs.length) group.tabs.at(-1).lines.push(line);
      else group.preamble.push(line);
    } else {
      plain.push(line);
    }
  }
  flushGroup();
  flushPlain();
  return segments;
}
