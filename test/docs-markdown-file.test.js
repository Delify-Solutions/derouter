import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDocMarkdownFile,
  serializeDocMarkdownFile,
  slugifyDocName,
  splitFrontMatter,
  docFileName,
} from "../src/shared/utils/docsMarkdownFile.js";
import { validateSlug } from "../src/lib/content/docsSlug.js";

const DOC = {
  title: "Bắt đầu: cài đặt \"nhanh\"",
  slug: "bat-dau",
  section: "Hướng dẫn",
  excerpt: "Một câu # không phải comment",
  summary: "Dòng một\nDòng hai: có dấu hai chấm",
  sortOrder: 7,
  isPublished: true,
  body: "## Bước 1\n\nChạy lệnh:\n\n```bash\n# cài đặt\nnpm i\n```\n\n---\n\nXong.",
};

test("export then import returns the same page", () => {
  const file = serializeDocMarkdownFile(DOC);
  assert.ok(file.startsWith("---\ntitle: "));
  assert.ok(file.includes("published: true\n---\n\n## Bước 1\n"));
  assert.ok(file.endsWith("Xong.\n"));
  const parsed = parseDocMarkdownFile(file, { filename: "khac.md" });
  assert.equal(parsed.hasFrontMatter, true);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.fields, {
    title: DOC.title,
    slug: DOC.slug,
    section: DOC.section,
    excerpt: DOC.excerpt,
    summary: DOC.summary,
    sortOrder: 7,
    isPublished: true,
  });
  assert.equal(parsed.body, DOC.body);
});

test("round trip keeps an unpublished page and empty fields", () => {
  const doc = { title: "T", slug: "t", section: "", excerpt: "", summary: "", sortOrder: 0, isPublished: false, body: "" };
  const parsed = parseDocMarkdownFile(serializeDocMarkdownFile(doc));
  assert.deepEqual(parsed.fields, { title: "T", slug: "t", section: "", excerpt: "", summary: "", sortOrder: 0, isPublished: false });
  assert.equal(parsed.body, "");
});

test("without front matter the first # heading is the title and the filename is the slug", () => {
  const md = "# Hướng dẫn Codex\n\nĐoạn mở đầu.\n\n## Cài đặt\n";
  const parsed = parseDocMarkdownFile(md, { filename: "Hướng dẫn Codex CLI.md" });
  assert.equal(parsed.hasFrontMatter, false);
  assert.equal(parsed.fields.title, "Hướng dẫn Codex");
  assert.equal(parsed.fields.slug, "huong-dan-codex-cli");
  assert.equal(parsed.body, "Đoạn mở đầu.\n\n## Cài đặt");
  assert.equal(parsed.fields.sortOrder, undefined);
  assert.equal(parsed.fields.isPublished, undefined);
});

test("a # line inside a code fence is not the title", () => {
  const md = "Intro\n\n```bash\n# not a title\n```\n\n# Real title\n\nBody";
  const parsed = parseDocMarkdownFile(md, { filename: "x.md" });
  assert.equal(parsed.fields.title, "Real title");
  assert.ok(parsed.body.includes("# not a title"));
  assert.ok(!parsed.body.includes("# Real title"));
});

test("extractTitle: false keeps the heading in the body", () => {
  const parsed = parseDocMarkdownFile("# Keep me\n\nText", { extractTitle: false });
  assert.equal(parsed.fields.title, undefined);
  assert.equal(parsed.body, "# Keep me\n\nText");
});

test("quoted values and colons in values", () => {
  const md = [
    "---",
    'title: "Giá: $10 / tháng"',
    "section: API: nâng cao",
    "excerpt: 'It''s fine'",
    'summary: "Có \\"ngoặc kép\\" bên trong"',
    "# a comment line",
    "unknown: ignored",
    "---",
    "Body",
  ].join("\n");
  const parsed = parseDocMarkdownFile(md, { filename: "gia.md" });
  assert.equal(parsed.fields.title, "Giá: $10 / tháng");
  assert.equal(parsed.fields.section, "API: nâng cao");
  assert.equal(parsed.fields.excerpt, "It's fine");
  assert.equal(parsed.fields.summary, 'Có "ngoặc kép" bên trong');
  assert.equal(parsed.fields.slug, "gia");
  assert.equal("unknown" in parsed.fields, false);
  assert.equal(parsed.body, "Body");
});

test("CRLF line endings and a BOM", () => {
  const md = "﻿---\r\ntitle: Win\r\nslug: win-doc\r\npublished: true\r\n---\r\n\r\nLine 1\r\nLine 2\r\n";
  const parsed = parseDocMarkdownFile(md);
  assert.equal(parsed.fields.title, "Win");
  assert.equal(parsed.fields.slug, "win-doc");
  assert.equal(parsed.fields.isPublished, true);
  assert.equal(parsed.body, "Line 1\nLine 2");
  assert.ok(!parsed.body.includes("\r"));
});

test("diacritics, đ and odd characters become a valid slug", () => {
  assert.equal(slugifyDocName("Đăng ký & thanh toán (VNĐ).md"), "dang-ky-thanh-toan-vnd");
  assert.equal(slugifyDocName("  Hạn mức — 5 giờ.markdown "), "han-muc-5-gio");
  assert.equal(slugifyDocName("API.md"), "api-doc");
  assert.equal(slugifyDocName("!!!.md"), "");
  const long = slugifyDocName(`${"a".repeat(70)}.md`);
  assert.equal(long.length, 64);
  for (const name of ["Đăng ký.md", "API.md", "x".repeat(80)]) {
    const slug = slugifyDocName(name);
    assert.equal(validateSlug(slug), null, `${name} → ${slug}`);
  }
});

test("invalid sortOrder and published are ignored with a warning", () => {
  const md = "---\ntitle: T\nslug: t\nsortOrder: mười\npublished: có\n---\nBody";
  const parsed = parseDocMarkdownFile(md);
  assert.equal(parsed.fields.sortOrder, undefined);
  assert.equal(parsed.fields.isPublished, undefined);
  assert.equal(parsed.warnings.length, 2);
  assert.match(parsed.warnings[0], /sortOrder/);
});

test("an invalid slug in front matter is slugified with a warning", () => {
  const parsed = parseDocMarkdownFile("---\ntitle: T\nslug: Bắt Đầu\n---\nBody", { filename: "other.md" });
  assert.equal(parsed.fields.slug, "bat-dau");
  assert.equal(parsed.warnings.length, 1);
});

test("a leading --- without a closing line is body, not front matter", () => {
  const md = "---\n\nJust a rule then text";
  const { hasFrontMatter, body } = splitFrontMatter(md);
  assert.equal(hasFrontMatter, false);
  assert.equal(body, md);
});

test("slug falls back to the title when the filename gives nothing", () => {
  const parsed = parseDocMarkdownFile("# Bảng giá\n\nx", { filename: "???.md" });
  assert.equal(parsed.fields.slug, "bang-gia");
});

test("download name is <slug>.md", () => {
  assert.equal(docFileName("bat-dau"), "bat-dau.md");
  assert.equal(docFileName(""), "tai-lieu.md");
});

test("a body that starts with a horizontal rule and has another later is not front matter", () => {
  const text = "---\n\nIntro para\n\n---\n\nMore";
  const parsed = parseDocMarkdownFile(text, { filename: "page.md", extractTitle: false });
  assert.equal(parsed.hasFrontMatter, false);
  assert.match(parsed.body, /Intro para/);
  assert.match(parsed.body, /More/);
});

test("a sortOrder too large to be a safe integer is refused with a warning", () => {
  const parsed = parseDocMarkdownFile(`---\ntitle: T\nsortOrder: ${"9".repeat(400)}\n---\nBody`);
  assert.equal(parsed.fields.sortOrder, undefined);
  assert.ok(parsed.warnings.some((w) => w.includes("sortOrder")));
});
