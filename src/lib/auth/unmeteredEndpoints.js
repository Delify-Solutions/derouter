import { resolveApiKeyOwner } from "../db/repos/billingRepo.js";

// Endpoints the router serves but does not meter yet: text-to-speech,
// speech-to-text, web search, web fetch and video generation never write a usage
// row, so nothing is ever charged for them. A customer key (one with an owning
// account) must not reach them, or a plan with a little credit left buys
// unlimited use of the operator's provider accounts. Admin and local keys have no
// owner, are never billed, and keep working.
//
// Remove an endpoint from here only together with the change that records and
// charges its usage.
export const UNMETERED_ENDPOINT_MESSAGE =
  "Endpoint này chưa được tính phí nên chưa mở cho API key của khách hàng.";

// Paths that call a provider directly instead of going through the masked chat
// handler (the Gemini native TTS path): metered, but they would hand a customer
// the provider's own model ids, headers and error texts and bypass the
// combo-only rule (spec model-privacy "Provider-native paths are closed to
// customer keys").
export const CUSTOMER_CLOSED_ENDPOINT_MESSAGE = "Endpoint này chưa mở cho API key của khách hàng.";

/**
 * The denial for a customer key on an endpoint closed to customers, or null when
 * the call may proceed (no key, or an admin/local key).
 * @returns {{ status:number, code:string, message:string } | null}
 */
export function refuseCustomerEndpointSync(db, apiKey, message = CUSTOMER_CLOSED_ENDPOINT_MESSAGE) {
  if (!apiKey) return null;
  if (!resolveApiKeyOwner(db, apiKey)) return null;
  return { status: 403, code: "endpoint_not_available", message };
}

/**
 * The denial for a customer key on an unmetered endpoint, or null when the call
 * may proceed (no key, or an admin/local key).
 * @returns {{ status:number, code:string, message:string } | null}
 */
export function refuseUnmeteredSync(db, apiKey) {
  return refuseCustomerEndpointSync(db, apiKey, UNMETERED_ENDPOINT_MESSAGE);
}
