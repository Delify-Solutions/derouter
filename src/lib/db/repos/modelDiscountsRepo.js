// Adapter-resolving wrappers around the driver-free engine in
// src/lib/billing/discounts.js (spec model-discounts). Routes and server
// components import this file; tests of the rules import the engine directly.
import { getAdapter } from "../driver.js";
import {
  listDiscountsSync,
  getDiscountSync,
  createDiscountSync,
  updateDiscountSync,
  deleteDiscountSync,
  resolveDiscountSync,
  renameComboInDiscountsSync,
  removeComboFromDiscountsSync,
  ruleStatus,
  analyzeOverlap,
  applyBpToPricing,
} from "../../billing/discounts.js";

export { applyBpToPricing };

/**
 * Rules of one scope (or all), each with its current `status` label, plus the
 * overlap analysis of the returned set.
 */
export async function listDiscounts({ scopeType = null, scopeId = null } = {}) {
  const db = await getAdapter();
  const nowMs = Date.now();
  const rules = listDiscountsSync(db, { scopeType, scopeId });
  return {
    rules: rules.map((rule) => ({ ...rule, status: ruleStatus(rule, nowMs) })),
    overlap: analyzeOverlap(rules, nowMs),
  };
}

export async function getDiscount(id) {
  const db = await getAdapter();
  return getDiscountSync(db, id);
}

export async function createDiscount(input) {
  const db = await getAdapter();
  let out;
  db.transaction(() => { out = createDiscountSync(db, input); });
  return out;
}

export async function updateDiscount(id, patch) {
  const db = await getAdapter();
  let out;
  db.transaction(() => { out = updateDiscountSync(db, id, patch); });
  return out;
}

export async function deleteDiscount(id) {
  const db = await getAdapter();
  return deleteDiscountSync(db, id);
}

export async function renameComboDiscounts(oldName, newName) {
  const db = await getAdapter();
  db.transaction(() => renameComboInDiscountsSync(db, oldName, newName));
}

export async function removeComboDiscounts(comboName) {
  const db = await getAdapter();
  db.transaction(() => removeComboFromDiscountsSync(db, comboName));
}

/**
 * Discounts in force right now for a set of models, for the price tables.
 * `userId` resolves that customer's group and paying plan; otherwise pass
 * `groupId` / `planId` (null = none). Returns Map<model, { totalBp, rawBp,
 * capped, endsAt, ruleIds, reasons }> holding only models that ARE discounted.
 * `reasons` = the distinct labels of the applied rules (the "Lý do giảm giá"
 * customers see), in rule order.
 */
/** Distinct non-empty labels of `rules`, in order. */
export function discountReasons(rules = []) {
  const out = [];
  for (const rule of rules) {
    const label = typeof rule?.label === "string" ? rule.label.trim() : "";
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Current reasons of the rules a past request was discounted by (usage history).
 * A deleted rule has no reason. Returns Map<ruleId, label>.
 */
export async function getDiscountLabels(ruleIds = []) {
  const ids = [...new Set((ruleIds || []).filter((id) => typeof id === "string" && id))];
  const out = new Map();
  if (ids.length === 0) return out;
  const db = await getAdapter();
  const marks = ids.map(() => "?").join(", ");
  for (const row of db.all(`SELECT id, label FROM modelDiscounts WHERE id IN (${marks})`, ids)) {
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label) out.set(row.id, label);
  }
  return out;
}

export async function getActiveDiscountsForModels(models, { userId = null, groupId, planId, at = null } = {}) {
  const db = await getAdapter();
  const out = new Map();
  for (const model of models || []) {
    const found = resolveDiscountSync(db, { at, requestedModel: model, userId, groupId, planId });
    if (found.totalBp > 0) {
      out.set(model, {
        totalBp: found.totalBp,
        rawBp: found.rawBp,
        capped: found.capped,
        endsAt: found.endsAt,
        ruleIds: found.ruleIds,
        reasons: discountReasons(found.rules),
      });
    }
  }
  return out;
}
