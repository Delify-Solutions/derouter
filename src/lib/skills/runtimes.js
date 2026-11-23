// The agents (Claude Code, Codex, omp, dsh, OpenCode) a skill can be installed
// into. One registry, shared by the repository, the installer script, the catalogue
// and both pages, so supporting another agent is one line here.
//
// Only an agent that also has a matching entry in engineTargets.js (ENGINE_TARGETS)
// belongs here. A skill's markdown calls tools that live in the engine; a skill with
// nowhere to register that engine is a set of instructions for tools that will never
// exist, which is worse than no skill at all — so the owner's call is to list an
// agent only once it can run both halves, not skills alone (2026-11-23).
//
// Each entry says how to find the agent on a machine and where it reads skills:
//   home     the folder the agent keeps under $HOME. Its presence is how the installer
//            tells which agents a machine has.
//   homeEnv  an environment variable that moves that folder (CLAUDE_CONFIG_DIR, …).
//   xdg      the folder's name under $XDG_CONFIG_HOME for agents that follow it
//            (default ~/.config), so `home` is only its default location.
//   xdgSkills  the same for a skills folder that is not `<xdg>/skills`.
//   skills   where the agent reads skill folders from, relative to $HOME. Omitted when
//            it is simply `<home>/skills`.
//
// Paths come from the agents' own documentation; keep an entry only when its location
// is known, because a skill written to a folder the agent never reads is silently
// useless.
//
// Dependency-free: imported by client components and rendered into the shell script.

/**
 * Internal plumbing, not a runtime any agent reads directly: when a skill goes to
 * two or more different folders, the installer writes one real copy here and links
 * every actual destination to it (place_skill, installScript.js) — an update then
 * touches one file instead of N.
 */
export const SHARED_SKILLS_DIR = ".agents/skills";

export const SKILL_RUNTIMES = [
  { id: "claude", label: "Claude Code", home: ".claude", homeEnv: "CLAUDE_CONFIG_DIR" },
  { id: "codex", label: "Codex", home: ".codex" },
  { id: "omp", label: "omp (Oh My Pi)", home: ".omp", skills: ".omp/agent/skills" },
  { id: "dsh", label: "dsh (DeepSeek Harness)", home: ".dsh", homeEnv: "DSH_HOME" },
  { id: "opencode", label: "OpenCode", home: ".config/opencode", xdg: "opencode" },
];

export const SKILL_RUNTIME_IDS = SKILL_RUNTIMES.map((runtime) => runtime.id);

/** Skills folder of a runtime, relative to $HOME (`.claude/skills`). */
export function runtimeSkillsDir(runtime) {
  return runtime.skills || `${runtime.home}/skills`;
}

export function runtimeLabel(id) {
  return SKILL_RUNTIMES.find((runtime) => runtime.id === id)?.label ?? id;
}

/** `~/.claude/skills/<slug>/` for a runtime, or null for an unknown id. */
export function runtimeInstallDir(id, slug) {
  const runtime = SKILL_RUNTIMES.find((r) => r.id === id);
  return runtime ? `~/${runtimeSkillsDir(runtime)}/${slug}/` : null;
}

/**
 * Runtime ids from whatever a payload or a stored row holds: an array, a JSON
 * array string, or the legacy single `target`. Unknown ids are dropped. An empty
 * result, and the legacy "generic", mean every agent — including agents added to the
 * registry later, which is why "all" is stored as an empty list and not as today's ids.
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

/** True when a resolved list names every agent in the registry. */
export function isEveryRuntime(list) {
  return SKILL_RUNTIME_IDS.every((id) => list.includes(id));
}

/**
 * What to store for a resolved list: `[]` when it is every agent (so the skill keeps
 * following the registry), otherwise the list itself in registry order.
 */
export function storedRuntimes(list) {
  const resolved = parseRuntimes(list);
  return isEveryRuntime(resolved) ? [] : SKILL_RUNTIME_IDS.filter((id) => resolved.includes(id));
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
