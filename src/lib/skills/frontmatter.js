// Reads the YAML frontmatter block at the top of a SKILL.md: just enough to turn a
// dropped file into a prefilled form (`name`, `description`). It is not a YAML
// parser; a value it cannot read simply stays empty and the admin types it.
// Dependency-free: it runs in the browser for the import preview.

/**
 * @returns {{ name: string, description: string, body: string }} `body` is the
 * whole text unchanged — the frontmatter is part of the skill file.
 */
export function readSkillFrontmatter(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = match ? parseBlock(match[1]) : {};
  return {
    name: String(fields.name ?? "").trim(),
    description: String(fields.description ?? "").trim(),
    body: source,
  };
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseBlock(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rest = m[2];
    if (/^[>|][+-]?$/.test(rest.trim())) {
      // Block scalar: the indented lines that follow, folded onto one line.
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[i + 1].trim());
        i += 1;
      }
      out[key] = parts.join(" ");
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** A directory-safe slug from a name; mirrors slugifySkill on the server. */
export function slugFromName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
