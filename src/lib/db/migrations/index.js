// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-money-and-tenants.js";
import m003 from "./003-nullable-userplan-planid.js";
import m004 from "./004-gift-redemption-repeat.js";
import m005 from "./005-usage-apikey-id.js";
import m006 from "./006-drop-plan-model-limits.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
