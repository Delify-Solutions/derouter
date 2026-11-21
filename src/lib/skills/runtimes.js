// The agent runtimes (Claude Code, Codex, Cursor, …) a skill can be installed
// into. One list, shared by the repository, the installer catalogue and both
// pages, so adding a runtime is one line here.
//
// `home` is the folder the agent keeps under the user's home directory; the
// installer uses its presence to tell which agents are on a machine. `skills` is
// where that agent reads skill directories from. Dependency-free: it is imported
// by client components too.

export const SKILL_RUNTIMES = [
  { id: "claude", label: "Claude Code", home: ".claude", skills: ".claude/skills" },
  { id: "codex", label: "Codex", home: ".codex", skills: ".codex/skills" },
  { id: "cursor", label: "Cursor", home: ".cursor", skills: ".cursor/skills" },
];

export const SKILL_RUNTIME_IDS = SKILL_RUNTIMES.map((runtime) => runtime.id);

export function runtimeLabel(id) {
  return SKILL_RUNTIMES.find((runtime) => runtime.id === id)?.label ?? id;
}

/** `~/.claude/skills/<slug>/` for a runtime, or null for an unknown id. */
export function runtimeInstallDir(id, slug) {
  const runtime = SKILL_RUNTIMES.find((r) => r.id === id);
  return runtime ? `~/${runtime.skills}/${slug}/` : null;
}

/**
 * Runtime ids from whatever a payload or a stored row holds: an array, a JSON
 * array string, or the legacy single `target`. Unknown ids are dropped; "generic"
 * and an empty result mean every runtime.
 */
export function parseRuntimes(value) {
  let list = value;
  if (typeof list === "string") {
    const text = list.trim();
    if (text.startsWith("[")) {
      try {
        list = JSON.parse(text);
      } catch {
        list = [];
      }
    } else {
      list = text ? [text] : [];
    }
  }
  if (!Array.isArray(list)) list = [];
  const known = [...new Set(list.filter((id) => SKILL_RUNTIME_IDS.includes(id)))];
  return known.length ? known : [...SKILL_RUNTIME_IDS];
}

/**
 * The agent selection after the admin toggles `id`. The last agent cannot be
 * switched off (a skill with none could never be installed); `changed` is false then,
 * so the picker can say why nothing happened.
 */
export function toggleRuntime(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (next.size === 0) return { value: [...selected], changed: false };
  return { value: SKILL_RUNTIME_IDS.filter((rid) => next.has(rid)), changed: true };
}
