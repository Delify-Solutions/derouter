// The agents (Claude Code, Codex, Cursor, omp, dsh, …) a skill can be installed
// into. One registry, shared by the repository, the installer script, the catalogue
// and both pages, so supporting another agent is one line here.
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
// Agents whose `skills` is the shared `.agents/skills` folder (Amp, Goose, Pi, Warp)
// read the same directory, so a skill is written there once. Paths come from the
// agents' own documentation; keep an entry only when its location is known, because a
// skill written to a folder the agent never reads is silently useless.
//
// Dependency-free: imported by client components and rendered into the shell script.

/** The folder several agents share; the installer keeps one canonical copy here. */
export const SHARED_SKILLS_DIR = ".agents/skills";

export const SKILL_RUNTIMES = [
  { id: "claude", label: "Claude Code", home: ".claude", homeEnv: "CLAUDE_CONFIG_DIR" },
  { id: "codex", label: "Codex", home: ".codex" },
  { id: "cursor", label: "Cursor", home: ".cursor" },
  { id: "omp", label: "omp (Oh My Pi)", home: ".omp", skills: ".omp/agent/skills" },
  { id: "dsh", label: "dsh (DeepSeek Harness)", home: ".dsh", homeEnv: "DSH_HOME" },
  { id: "opencode", label: "OpenCode", home: ".config/opencode", xdg: "opencode" },
  { id: "gemini", label: "Gemini CLI", home: ".gemini" },
  { id: "copilot", label: "GitHub Copilot", home: ".copilot" },
  { id: "windsurf", label: "Windsurf", home: ".codeium/windsurf" },
  { id: "droid", label: "Droid", home: ".factory" },
  { id: "kilo", label: "Kilo Code", home: ".kilo" },
  { id: "roo", label: "Roo Code", home: ".roo" },
  { id: "trae", label: "Trae", home: ".trae" },
  { id: "qwen", label: "Qwen Code", home: ".qwen" },
  // goose.ai's own docs put skills under the shared folder, not a goose-specific one
  // (goose-docs.ai, Skills Extension page) — `home`/`xdg` still mark it as installed.
  { id: "goose", label: "Goose", home: ".config/goose", xdg: "goose", skills: SHARED_SKILLS_DIR },
  { id: "kiro", label: "Kiro CLI", home: ".kiro" },
  { id: "junie", label: "Junie", home: ".junie" },
  { id: "qoder", label: "Qoder", home: ".qoder" },
  { id: "antigravity", label: "Antigravity", home: ".gemini/antigravity", skills: ".gemini/config/skills" },
  // The Antigravity CLI (`agy`) reads the same skills folder but is detected by its own folder.
  { id: "agy", label: "Antigravity CLI", home: ".gemini/antigravity-cli", skills: ".gemini/config/skills" },
  { id: "zcode", label: "ZCode", home: ".zcode" },
  // ampcode.com's own worked example writes to the shared folder, not a
  // per-agent one under .config (that path appeared nowhere in Amp's own docs).
  { id: "amp", label: "Amp", home: ".config/amp", xdg: "amp", skills: SHARED_SKILLS_DIR },
  // docs.cline.bot: Cline's own skills folder, never the shared one.
  { id: "cline", label: "Cline", home: ".cline" },
  { id: "pi", label: "Pi", home: ".pi/agent", skills: SHARED_SKILLS_DIR },
  { id: "warp", label: "Warp", home: ".warp", skills: SHARED_SKILLS_DIR },
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
