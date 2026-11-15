// Which models a plan includes (spec plan-model-access).
//
// A plan may restrict the combos its purchases can call. The rule is a NARROWING,
// never a widening: the account's group allow-list is the outer bound and is
// enforced first (keyEnforcement), and a plan may only cut that set down. That is
// why nothing here can grant access on its own — `unionOfModels` is always
// intersected with the group's list by the caller.
//
// Three shapes appear in this module and they are not interchangeable:
//
//   null        no restriction (every plan created before this change)
//   []          refused at validation; never stored, never read here
//   [names…]    exactly these, matched with the group's own matcher
//
// PURE (no driver, no I/O): admission, charging, enforcement, the model listings
// and the admin form all read the same rules from here, so the request path and the
// screen that advertises a model cannot disagree.
import { matchesAllowed } from "../auth/modelMatching.js";

/**
 * The stored shape of a plan's / purchase's model list.
 *
 * @param {unknown} raw  array, JSON string, null or undefined
 * @returns {string[]|null} null = unrestricted; otherwise a de-duplicated list
 */
export function normalizePlanModels(raw) {
  // Callers hand this both shapes: a parsed array (a plan object, an API body) and
  // the raw TEXT column (a `userPlans`/`orders` row read straight from SQL). Accepting
  // the JSON string keeps every reader from having to remember which one it holds.
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const list = Array.isArray(value) ? value : null;
  if (!list || list.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (entry == null) continue;
    const name = String(entry).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length > 0 ? out : null;
}

/**
 * Does this restriction allow `model`?
 *
 * `null` (or a missing list) allows everything. A request with no model at all —
 * a non-chat endpoint — is allowed too: this layer answers "may this purchase pay
 * for THIS model", and with no model there is nothing to refuse.
 *
 * Matching is `matchesAllowed`, the same function the group allow-list uses, so a
 * combo name, a provider-prefixed id and a dated id collapse identically in both.
 */
export function planAllowsModel(allowedModels, model) {
  const allowed = normalizePlanModels(allowedModels);
  if (!allowed) return true;
  if (!model) return true;
  return matchesAllowed(model, allowed);
}

/** Is this list a restriction at all? Used by the UI to decide whether to mention models. */
export function isRestricted(allowedModels) {
  return normalizePlanModels(allowedModels) !== null;
}

/**
 * The models a set of live purchases allows, or `null` meaning "no restriction".
 *
 * One unrestricted purchase makes the whole set unrestricted: a customer who holds
 * a plan covering everything can call everything that purchase pays for, so listing
 * a subset would be wrong.
 *
 * The union is meant to be intersected with the group's allowed list by the caller —
 * this function answers only "what do the purchases say".
 *
 * @param {Array<{allowedModels?: unknown}>} purchases live purchases
 * @returns {string[]|null}
 */
export function unionOfModels(purchases) {
  if (!Array.isArray(purchases) || purchases.length === 0) return null;
  const union = [];
  const seen = new Set();
  for (const purchase of purchases) {
    const allowed = normalizePlanModels(purchase?.allowedModels);
    // An unrestricted live purchase opens the whole group list.
    if (!allowed) return null;
    for (const name of allowed) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(name);
    }
  }
  return union.length > 0 ? union : null;
}

/**
 * Does an effective allow-list permit `model`?
 *
 * `null` = unrestricted. An ARRAY = exactly those, and an EMPTY array means "nothing"
 * — which is why this is a function and not `matchesAllowed`, whose empty list means
 * "no restriction" (the group convention). A purchase list entirely outside the
 * buyer's group leaves nothing callable, and that must not read as "everything".
 */
export function effectiveAllows(effective, model) {
  if (!effective) return true;
  if (!model) return true;
  return effective.length > 0 && matchesAllowed(model, effective);
}

/**
 * The effective allow-list for a customer: the group's list narrowed by what the
 * live purchases allow.
 *
 * `groupAllowed` null/empty = the group allows everything (the shipped meaning of an
 * empty group list). `purchaseUnion` null = the purchases restrict nothing.
 *
 * @param {string[]|null} groupAllowed the group's allow-list
 * @param {string[]|null} purchaseUnion `unionOfModels` over the live purchases
 * @returns {string[]|null} null = unrestricted; [] = nothing callable; else exactly those
 */
export function effectiveModels(groupAllowed, purchaseUnion) {
  const group = normalizePlanModels(groupAllowed);
  const plans = normalizePlanModels(purchaseUnion);
  // The purchases restrict nothing → whatever the group allows, exactly as today.
  if (!plans) return group;
  // The group allows everything → the purchases are the only bound.
  if (!group) return plans;
  return plans.filter((model) => matchesAllowed(model, group));
}
