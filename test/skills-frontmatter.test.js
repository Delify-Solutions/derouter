// The frontmatter reader that prefills the "add many skills" review list, and the
// runtime helpers shared by the installer, the repository and both pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSkillFrontmatter, slugFromName } from "../src/lib/skills/frontmatter.js";
import { parseRuntimes, runtimeInstallDir, runtimeLabel, SKILL_RUNTIME_IDS } from "../src/lib/skills/runtimes.js";

test("name and description are read from the frontmatter block", () => {
  const text = "---\nname: rt-recon-pipeline\ndescription: Quét bề mặt domain\nlicense: MIT\n---\n\n# Body\n";
  const fm = readSkillFrontmatter(text);
  assert.equal(fm.name, "rt-recon-pipeline");
  assert.equal(fm.description, "Quét bề mặt domain");
  assert.equal(fm.body, text); // the file is kept whole
});

test("quoted values, folded and literal blocks, CRLF and a BOM", () => {
  assert.equal(readSkillFrontmatter('---\nname: "Quoted Name"\ndescription: \'single\'\n---\n').name, "Quoted Name");
  const folded = readSkillFrontmatter("---\nname: x\ndescription: >\n  first line\n  second line\n---\nbody");
  assert.equal(folded.description, "first line second line");
  const literal = readSkillFrontmatter("---\nname: x\ndescription: |-\n  one\n  two\n---\n");
  assert.equal(literal.description, "one two");
  const crlf = readSkillFrontmatter("---\r\nname: crlf\r\ndescription: d\r\n---\r\nbody");
  assert.equal(crlf.name, "crlf");
  assert.equal(readSkillFrontmatter("﻿---\nname: bom\n---\n").name, "bom");
});

test("a file without frontmatter, or an unterminated block, reads as empty", () => {
  assert.deepEqual(
    { ...readSkillFrontmatter("# Just markdown\n\nname: not frontmatter") , body: undefined },
    { name: "", description: "", body: undefined }
  );
  assert.equal(readSkillFrontmatter("---\nname: open\nno closing").name, "");
  assert.equal(readSkillFrontmatter("").name, "");
  assert.equal(readSkillFrontmatter(null).name, "");
});

test("a slug is derived the way the server derives it", () => {
  assert.equal(slugFromName("Kỹ năng Đọc File"), "ky-nang-doc-file");
  assert.equal(slugFromName("  Red Team / Recon  "), "red-team-recon");
  assert.equal(slugFromName(`${"a".repeat(63)} b`), "a".repeat(63));
  assert.equal(slugFromName(""), "");
});

test("runtimes: arrays, JSON strings and the legacy single target all parse", () => {
  const all = SKILL_RUNTIME_IDS;
  assert.deepEqual(parseRuntimes(["codex", "claude"]), ["codex", "claude"]);
  assert.deepEqual(parseRuntimes('["cursor"]'), ["cursor"]);
  assert.deepEqual(parseRuntimes("codex"), ["codex"]);
  assert.deepEqual(parseRuntimes(["claude", "claude"]), ["claude"]);
  assert.deepEqual(parseRuntimes(["vim", "codex"]), ["codex"]); // unknown ids dropped
  for (const empty of [undefined, null, "", "[]", [], "generic", ["vim"], "{not json", 5]) {
    assert.deepEqual(parseRuntimes(empty), all, String(empty)); // nothing usable → every runtime
  }
});

test("install directories and labels come from the one runtime list", () => {
  assert.equal(runtimeInstallDir("claude", "rt-x"), "~/.claude/skills/rt-x/");
  assert.equal(runtimeInstallDir("codex", "rt-x"), "~/.codex/skills/rt-x/");
  assert.equal(runtimeInstallDir("cursor", "rt-x"), "~/.cursor/skills/rt-x/");
  assert.equal(runtimeInstallDir("vim", "rt-x"), null);
  assert.equal(runtimeLabel("claude"), "Claude Code");
  assert.equal(runtimeLabel("unknown"), "unknown");
});
