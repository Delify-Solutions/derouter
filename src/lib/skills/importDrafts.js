// Turning the files an admin picked or dropped into draft skills — pure logic, so it
// is tested in plain Node. The import modal only reads the files and renders.
import { readSkillFrontmatter, slugFromName } from "./frontmatter.js";

export const MAX_DRAFT_BYTES = 512 * 1024;
const SKILL_FILE = /^skill\.md$/i;
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Which of the chosen files are skills. A loose `.md` file is one skill. Inside a
 * folder only `SKILL.md` is: the rest of a skill's folder (README.md,
 * references/*.md) is supporting material, not more skills.
 *
 * @param {{ name: string, path?: string }[]} entries `path` is `folder/sub/file.md`
 * @returns {{ picked: object[], ignored: number }}
 */
export function pickSkillFiles(entries) {
  const picked = [];
  let ignored = 0;
  for (const entry of entries) {
    const path = String(entry.path || entry.name || "");
    const inFolder = path.split("/").filter(Boolean).length >= 2;
    const isMarkdown = MARKDOWN.test(entry.name || "");
    if (isMarkdown && (!inFolder || SKILL_FILE.test(entry.name))) picked.push(entry);
    else ignored += 1;
  }
  return { picked, ignored };
}

/**
 * Name, slug and summary for one file. A `SKILL.md` inside a folder takes the
 * folder's name as slug because that is the directory the customer's agent will
 * see; a loose file takes its frontmatter `name`, then its file name.
 */
export function draftFields({ path, name: fileName, text }) {
  const fm = readSkillFrontmatter(text);
  const parts = String(path || fileName || "").split("/").filter(Boolean);
  const folder = parts.length >= 2 && SKILL_FILE.test(fileName || "") ? parts[parts.length - 2] : "";
  const stem = String(fileName || "").replace(/\.(md|markdown|txt)$/i, "");
  return {
    name: fm.name || folder || stem,
    slug: slugFromName(folder || fm.name || stem),
    summary: fm.description.slice(0, 200),
    body: text,
    bytes: new TextEncoder().encode(text).length,
  };
}

/** Flags that keep a draft out of the request. */
export function draftProblem(draft) {
  if (!draft.body.trim()) return "File rỗng";
  if (draft.bytes > MAX_DRAFT_BYTES) return "Lớn hơn 512 KB";
  return "";
}
