// Docs Markdown pipeline: sanitiser (server fallback path), image figures and
// tab blocks. Plain Node has no DOMParser, so renderMarkdown here takes the same
// path the /docs page takes when it renders on the server.
import { test } from "node:test";
import assert from "node:assert/strict";

const { renderMarkdown, sanitizeHtml } = await import("../src/shared/utils/markdown.js");
const { splitTabBlocks } = await import("../src/shared/utils/docsTabs.js");

test("links and images keep safe URLs, dangerous schemes become #", () => {
  const html = renderMarkdown(
    "[docs](/docs/quickstart) ![shot](/docs-img/a/01.png) [bad](javascript:alert(1)) [bad2](java&#x73;cript:alert(1))"
  );
  assert.match(html, /href="\/docs\/quickstart"/);
  assert.match(html, /src="\/docs-img\/a\/01\.png"/);
  assert.equal((html.match(/href="#"/g) || []).length, 2);
  assert.doesNotMatch(html, /javascript:/i);
});

test("raw script, handlers and blocked tags are removed", () => {
  const html = sanitizeHtml('<script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="/x"></iframe><a href="/ok" onclick="x()">ok</a>');
  assert.doesNotMatch(html, /script|onerror|onclick|iframe/i);
  assert.match(html, /href="\/ok"/);
});

test("code blocks that mention attributes are left alone", () => {
  const html = renderMarkdown('```bash\ncurl -H "x" onclick=1 href="a"\n```');
  assert.match(html, /onclick=1 href=&quot;a&quot;/);
});

test("image renders as a figure with the alt text as caption and an empty alt", () => {
  const html = renderMarkdown('![Màn hình "A" <b>](/docs-img/a/01.png)');
  assert.match(html, /<span class="docs-figure"><img src="\/docs-img\/a\/01\.png" alt="" loading="lazy">/);
  assert.match(html, /<span class="docs-figure-caption">Màn hình &quot;A&quot; &lt;b&gt;<\/span>/);
});

// ── tabs ────────────────────────────────────────────────────────────────────

const TABS = [
  ":::tabs",
  "::tab[CC Switch]",
  "Mở CC Switch.",
  "::tab[Thủ công]",
  "```bash",
  "echo hi",
  "```",
  ":::",
].join("\n");

test("splitTabBlocks splits plain text and tab groups", () => {
  const segments = splitTabBlocks(`Trước\n\n${TABS}\n\nSau`);
  assert.deepEqual(segments.map((s) => s.type), ["md", "tabs", "md"]);
  assert.deepEqual(segments[1].tabs.map((t) => t.title), ["CC Switch", "Thủ công"]);
  assert.equal(segments[1].tabs[0].body, "Mở CC Switch.");
});

test("directives inside a fenced code block are code, not directives", () => {
  const text = [
    ":::tabs",
    "::tab[A]",
    "````md",
    "```",
    "::tab[Fake]",
    ":::",
    "```",
    "````",
    "::tab[B]",
    "b",
    ":::",
  ].join("\n");
  const [group] = splitTabBlocks(text);
  assert.deepEqual(group.tabs.map((t) => t.title), ["A", "B"]);
  assert.match(group.tabs[0].body, /::tab\[Fake\]/);
});

test("a missing closing fence ends the block at the end of the document", () => {
  const [group] = splitTabBlocks(":::tabs\n::tab[A]\na\n::tab[B]\nb");
  assert.equal(group.type, "tabs");
  assert.equal(group.tabs.length, 2);
  assert.equal(group.tabs[1].body, "b");
});

test(":::tabs without any tab degrades to ordinary Markdown", () => {
  const segments = splitTabBlocks(":::tabs\njust text\n:::");
  assert.deepEqual(segments.map((s) => s.type), ["md"]);
  assert.match(segments[0].text, /just text/);
});

test("a stray ::: outside a tab group is plain text", () => {
  const segments = splitTabBlocks("a\n:::\nb");
  assert.deepEqual(segments.map((s) => s.type), ["md"]);
});

test("renderMarkdown emits an accessible tablist with every panel in the HTML", () => {
  const html = renderMarkdown(TABS);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 2);
  assert.match(html, /aria-selected="true"[^>]*tabindex="0"[^>]*data-tab-label="CC Switch"/);
  assert.match(html, /aria-controls="docs-tabs-0-panel-1"/);
  assert.match(html, /aria-labelledby="docs-tabs-0-tab-1"/);
  assert.match(html, /<code class="language-bash">echo hi/);
  // Ids stay unique across groups.
  const two = renderMarkdown(`${TABS}\n\n${TABS}`);
  assert.match(two, /id="docs-tabs-1-tab-0"/);
});

test("a single tab renders as a labelled block without a tablist", () => {
  const html = renderMarkdown(":::tabs\n::tab[Chỉ một]\nnội dung\n:::");
  assert.doesNotMatch(html, /role="tablist"/);
  assert.match(html, /docs-tab-single/);
  assert.match(html, /Chỉ một/);
});

test("tab titles cannot inject markup or handlers", () => {
  const html = renderMarkdown(':::tabs\n::tab[<img src=x onerror=alert(1)>]\na\n::tab["onmouseover="x]\nb\n:::');
  assert.doesNotMatch(html, /<img/);
  // No tag may carry a handler attribute; the text itself is escaped.
  assert.doesNotMatch(html.replace(/"[^"]*"/g, '""'), /<[^>]*\son(error|mouseover)=/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-tab-label="&quot;onmouseover=&quot;x"/);
});

test("raw HTML inside a tab body is still sanitised", () => {
  const html = renderMarkdown(":::tabs\n::tab[A]\n<script>alert(1)</script><a href=\"javascript:x\">x</a>\n::tab[B]\nb\n:::");
  assert.doesNotMatch(html, /<script|javascript:/i);
});
