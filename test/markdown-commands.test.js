import { test } from "node:test";
import assert from "node:assert/strict";

import { applyMarkdownCommand, applyIndent } from "../src/shared/utils/markdownCommands.js";

function run(command, value, start, end = start) {
  const edit = applyMarkdownCommand(command, value, start, end);
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { next, selected: next.slice(edit.selectionStart, edit.selectionEnd), edit };
}

test("bold wraps the selection and toggles off", () => {
  const { next, selected, edit } = run("bold", "a word b", 2, 6);
  assert.equal(next, "a **word** b");
  assert.equal(selected, "word");
  const off = applyMarkdownCommand("bold", next, edit.selectionStart, edit.selectionEnd);
  assert.equal(next.slice(0, off.start) + off.text + next.slice(off.end), "a word b");
});

test("bold without a selection inserts a selected placeholder", () => {
  const { next, selected } = run("bold", "", 0);
  assert.equal(next, "**chữ đậm**");
  assert.equal(selected, "chữ đậm");
});

test("h2 replaces an existing heading level", () => {
  assert.equal(run("h2", "### Title", 3).next, "## Title");
  assert.equal(run("h3", "plain", 0).next, "### plain");
  assert.equal(run("h2", "## Title", 4).next, "Title");
});

test("lists prefix every selected line and toggle off", () => {
  const value = "one\ntwo\nthree";
  const bullets = run("bulletList", value, 0, value.length).next;
  assert.equal(bullets, "- one\n- two\n- three");
  assert.equal(run("bulletList", bullets, 0, bullets.length).next, value);
  assert.equal(run("orderedList", value, 0, value.length).next, "1. one\n2. two\n3. three");
  assert.equal(run("quote", "x", 0, 1).next, "> x");
});

test("link selects the url placeholder; a selected url becomes the target", () => {
  const a = run("link", "see docs", 4, 8);
  assert.equal(a.next, "see [docs](https://)");
  assert.equal(a.selected, "https://");
  const b = run("link", "https://example.com", 0, 19);
  assert.equal(b.next, "[văn bản](https://example.com)");
  assert.equal(b.selected, "văn bản");
  assert.equal(run("image", "", 0).next, "![mô tả ảnh](https://)");
});

test("code block and table stand on their own lines", () => {
  assert.equal(run("codeBlock", "before", 6).next, "before\n\n```\ncode\n```");
  const t = run("table", "a\nb", 1);
  assert.equal(t.next, "a\n\n| Cột 1 | Cột 2 |\n| --- | --- |\n| Ô 1 | Ô 2 |\n\nb");
  assert.equal(t.selected, "Cột 1");
});

test("inline code over several lines becomes a block", () => {
  assert.equal(run("code", "x\ny", 0, 3).next, "```\nx\ny\n```");
});

test("Tab inserts two spaces; with lines selected it indents and outdents", () => {
  const ins = applyIndent("ab", 1, 1);
  assert.equal(ins.text, "  ");
  const value = "a\nb";
  const ind = applyIndent(value, 0, 3);
  assert.equal(ind.text, "  a\n  b");
  const out = applyIndent("  a\n  b", 0, 7, true);
  assert.equal(out.text, "a\nb");
});
