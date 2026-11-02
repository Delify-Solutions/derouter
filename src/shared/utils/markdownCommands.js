// Toolbar commands of the docs Markdown editor, as pure text transforms.
//
// Each command takes the textarea value and selection and returns the range to
// replace, the replacement, and the selection to restore afterwards. The editor
// applies the edit through the browser's insertText (so Ctrl+Z still works);
// keeping the logic here lets the tests run it without a DOM.

/**
 * @typedef {{ start: number, end: number, text: string, selectionStart: number, selectionEnd: number }} MarkdownEdit
 * `start`/`end` is the range of the ORIGINAL value replaced by `text`;
 * the selection offsets refer to the value after the edit.
 */

const PLACEHOLDERS = {
  bold: "chữ đậm",
  italic: "chữ nghiêng",
  code: "code",
  link: "văn bản",
  image: "mô tả ảnh",
  heading: "Tiêu đề",
  item: "mục",
  quote: "trích dẫn",
};

function lineStart(value, index) {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value, index) {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

/** Range of whole lines touched by the selection. A selection ending at column 0 excludes that line. */
function selectedLines(value, start, end) {
  const from = lineStart(value, start);
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const to = lineEnd(value, effectiveEnd);
  return { from, to, lines: value.slice(from, to).split("\n") };
}

function wrap(value, start, end, marker, placeholder) {
  const selected = value.slice(start, end);
  const m = marker.length;
  // Toggle off when the selection is already wrapped (markers just outside it).
  if (
    selected &&
    value.slice(start - m, start) === marker &&
    value.slice(end, end + m) === marker
  ) {
    return { start: start - m, end: end + m, text: selected, selectionStart: start - m, selectionEnd: end - m };
  }
  const inner = selected || placeholder;
  return {
    start,
    end,
    text: `${marker}${inner}${marker}`,
    selectionStart: start + m,
    selectionEnd: start + m + inner.length,
  };
}

// Prefix every selected line. If every non-empty line already has the prefix,
// remove it instead (toolbar buttons toggle).
function prefixLines(value, start, end, makePrefix, matchPrefix, placeholder) {
  const { from, to, lines } = selectedLines(value, start, end);
  const content = lines.filter((l) => l.trim());
  const allPrefixed = content.length > 0 && content.every((l) => matchPrefix.test(l));
  let n = 0;
  const next = lines.map((line) => {
    if (allPrefixed) return line.replace(matchPrefix, "");
    if (!line.trim() && lines.length > 1) return line;
    n += 1;
    const stripped = line.replace(matchPrefix, "");
    return `${makePrefix(n)}${stripped || placeholder}`;
  });
  const text = next.join("\n");
  if (lines.length === 1 && !allPrefixed) {
    // Single line: select the placeholder, or put the caret at the end.
    const prefix = makePrefix(1);
    const selStart = from + prefix.length;
    return {
      start: from, end: to, text,
      selectionStart: lines[0].replace(matchPrefix, "") ? from + text.length : selStart,
      selectionEnd: from + text.length,
    };
  }
  return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}

// A block (code fence, table) must stand on its own lines with a blank line
// before and after, or marked folds it into the paragraph around it.
function insertBlock(value, start, end, block, selectFrom, selectLength) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  let lead = "";
  if (before && !before.endsWith("\n\n")) lead = before.endsWith("\n") ? "\n" : "\n\n";
  let tail = "";
  if (after && !after.startsWith("\n\n")) tail = after.startsWith("\n") ? "\n" : "\n\n";
  const text = `${lead}${block}${tail}`;
  const selectionStart = start + lead.length + selectFrom;
  return { start, end, text, selectionStart, selectionEnd: selectionStart + selectLength };
}

const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^\s*[-*+]\s+/;
const ORDERED_RE = /^\s*\d+[.)]\s+/;
const QUOTE_RE = /^>\s?/;

export const MARKDOWN_COMMANDS = ["h2", "h3", "bold", "italic", "code", "codeBlock", "link", "image", "bulletList", "orderedList", "quote", "table"];

/**
 * @param {string} command one of MARKDOWN_COMMANDS
 * @param {string} value textarea value
 * @param {number} start selectionStart
 * @param {number} end selectionEnd
 * @returns {MarkdownEdit | null}
 */
export function applyMarkdownCommand(command, value, start, end) {
  const v = String(value ?? "");
  const s = Math.max(0, Math.min(start, v.length));
  const e = Math.max(s, Math.min(end, v.length));
  const selected = v.slice(s, e);

  switch (command) {
    case "h2":
    case "h3": {
      const hashes = command === "h2" ? "## " : "### ";
      const { from, to, lines } = selectedLines(v, s, e);
      const line = lines.join(" ").replace(HEADING_RE, "");
      // Same level again removes the heading.
      const already = lines.length === 1 && lines[0].startsWith(hashes) && !lines[0].startsWith(`${hashes.trim()}#`);
      const text = already ? line : `${hashes}${line || PLACEHOLDERS.heading}`;
      const caretAtEnd = already || Boolean(line);
      return {
        start: from, end: to, text,
        selectionStart: caretAtEnd ? from + text.length : from + hashes.length,
        selectionEnd: from + text.length,
      };
    }
    case "bold":
      return wrap(v, s, e, "**", PLACEHOLDERS.bold);
    case "italic":
      return wrap(v, s, e, "*", PLACEHOLDERS.italic);
    case "code":
      if (selected.includes("\n")) return applyMarkdownCommand("codeBlock", v, s, e);
      return wrap(v, s, e, "`", PLACEHOLDERS.code);
    case "codeBlock": {
      const inner = selected.replace(/\n$/, "") || PLACEHOLDERS.code;
      return insertBlock(v, s, e, "```\n" + inner + "\n```", 4, inner.length);
    }
    case "link":
    case "image": {
      const bang = command === "image" ? "!" : "";
      const looksLikeUrl = /^(https?:\/\/|\/)\S*$/.test(selected.trim());
      if (looksLikeUrl) {
        const label = command === "image" ? PLACEHOLDERS.image : PLACEHOLDERS.link;
        const text = `${bang}[${label}](${selected.trim()})`;
        return { start: s, end: e, text, selectionStart: s + bang.length + 1, selectionEnd: s + bang.length + 1 + label.length };
      }
      const label = selected || (command === "image" ? PLACEHOLDERS.image : PLACEHOLDERS.link);
      const url = "https://";
      const text = `${bang}[${label}](${url})`;
      const urlAt = s + bang.length + label.length + 3;
      return { start: s, end: e, text, selectionStart: urlAt, selectionEnd: urlAt + url.length };
    }
    case "bulletList":
      return prefixLines(v, s, e, () => "- ", BULLET_RE, PLACEHOLDERS.item);
    case "orderedList":
      return prefixLines(v, s, e, (n) => `${n}. `, ORDERED_RE, PLACEHOLDERS.item);
    case "quote":
      return prefixLines(v, s, e, () => "> ", QUOTE_RE, PLACEHOLDERS.quote);
    case "table": {
      const block = "| Cột 1 | Cột 2 |\n| --- | --- |\n| Ô 1 | Ô 2 |";
      return insertBlock(v, s, e, block, 2, "Cột 1".length);
    }
    default:
      return null;
  }
}

/**
 * Tab / Shift+Tab inside the editor. Without a multi-line selection Tab inserts
 * two spaces; with one it indents every selected line. Shift+Tab removes up to
 * two leading spaces from each selected line.
 * @returns {MarkdownEdit}
 */
export function applyIndent(value, start, end, outdent = false) {
  const v = String(value ?? "");
  const multiLine = v.slice(start, end).includes("\n");
  if (!outdent && !multiLine) {
    return { start, end, text: "  ", selectionStart: start + 2, selectionEnd: start + 2 };
  }
  const { from, to, lines } = selectedLines(v, start, end);
  const next = lines.map((line) => (outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`));
  const text = next.join("\n");
  if (!multiLine) {
    const removed = lines[0].length - next[0].length;
    const caret = Math.max(from, start - removed);
    return { start: from, end: to, text, selectionStart: caret, selectionEnd: caret };
  }
  return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}
