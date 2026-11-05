// Customers see and call combos only (spec model-privacy).
//
// One setting, `hideUpstreamModels` (default on), governs it:
//   - a customer key may call a chat model only by a combo name;
//   - the response a customer key receives is masked (publicModel.js);
//   - the customer ledger and the public usage API show combo names only.
// (/v1/models already lists combos only for every caller.)
// Admin keys and keyless local use are never affected.
//
// SYNCHRONOUS, takes the adapter. Relative imports only (tests import it).
import { parseJson } from "../db/helpers/jsonCol.js";
import { resolveApiKeyOwner } from "../db/repos/billingRepo.js";
import { hiddenModelIds, hiddenProviderIds } from "./publicModel.js";

/** True unless an admin switched the protection off. */
export function hideUpstreamModelsEnabled(settings) {
  return settings?.hideUpstreamModels !== false;
}

/** The same switch, read from the settings row inside a sync path. */
export function hideUpstreamModelsSync(db) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const data = row ? parseJson(row.data, {}) || {} : {};
  return hideUpstreamModelsEnabled(data);
}

/** True for a key that belongs to a customer account. */
export function isCustomerKeySync(db, apiKey) {
  if (!apiKey) return false;
  const owner = resolveApiKeyOwner(db, apiKey);
  return Boolean(owner?.userId);
}

/** True when `name` is the name of a combo. */
export function isComboNameSync(db, name) {
  if (typeof name !== "string" || !name) return false;
  return Boolean(db.get(`SELECT 1 AS x FROM combos WHERE name = ? LIMIT 1`, [name]));
}

/**
 * Whether a customer key may call `model` on a chat endpoint: always when the
 * protection is off or the key is not a customer's, otherwise only a combo name.
 */
export function customerMayCallSync(db, { apiKey, model, settings = null }) {
  const enabled = settings ? hideUpstreamModelsEnabled(settings) : hideUpstreamModelsSync(db);
  if (!enabled || !isCustomerKeySync(db, apiKey)) return true;
  return isComboNameSync(db, model);
}

/**
 * The mask for one chat response, or null when it must go out unchanged (admin
 * key, keyless, protection off). `members` are the combo's models,
 * `upstream` the ids the engine recorded using.
 */
export function publicModelContextSync(db, settings, { apiKey, publicName, members = [], upstream = [], providers = [] }) {
  if (!publicName || !hideUpstreamModelsEnabled(settings)) return null;
  if (!isCustomerKeySync(db, apiKey)) return null;
  return maskOptionsFor({ publicName, members, upstream, providers });
}

/** The mask options for a public name and what stands behind it. */
export function maskOptionsFor({ publicName, members = [], upstream = [], providers = [] }) {
  return {
    publicName,
    ids: hiddenModelIds({ members: [...members], upstream: [...upstream], publicName }),
    providers: hiddenProviderIds({ members: [...members], providers: [...providers], publicName }),
  };
}
