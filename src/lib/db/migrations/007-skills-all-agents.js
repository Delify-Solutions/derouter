// Migration 007 — skills that name every original agent now mean "every agent".
//
// Until now a skill stored the explicit list of agents it was for, and "all" was
// the three agents that existed (claude, codex, cursor). The agent registry has
// grown (omp, dsh, …), and "all" is now stored as an empty list so a skill keeps
// following the registry. A row holding exactly the original three was "all" — the
// admin had no other choice to make — so it is rewritten to `[]`. Any other list is
// a deliberate subset and stays as it is.
//
// Databases older than v46 have no `targets` column yet (the additive schema sync
// runs after migrations): there is nothing to rewrite, and the column starts NULL.

const LEGACY_ALL = ["claude", "codex", "cursor"];

function hasColumn(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

const skillsAllAgentsMigration = {
  version: 7,
  name: "skills-all-agents",
  up(db) {
    const table = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skills'`);
    if (!table || !hasColumn(db, "skills", "targets")) return;
    const rows = db.all(`SELECT id, targets FROM skills WHERE targets IS NOT NULL`);
    for (const row of rows) {
      let list;
      try {
        list = JSON.parse(row.targets);
      } catch {
        continue;
      }
      if (!Array.isArray(list) || list.length !== LEGACY_ALL.length) continue;
      if (LEGACY_ALL.every((id) => list.includes(id))) {
        db.run(`UPDATE skills SET targets = '[]', target = 'generic' WHERE id = ?`, [row.id]);
      }
    }
  },
};

export default skillsAllAgentsMigration;
