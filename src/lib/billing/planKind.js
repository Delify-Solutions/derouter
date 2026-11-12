// Two kinds of plan, one engine.
//
//   llm    a credit pool spent at the token price of whatever model is called
//   image  a pool of generated images, spent one image at a time
//
// An image plan is NOT a credit plan with a different rate. Its balance is a
// count (`userPlans.imageRemaining`), its windows count images, and it can only
// pay for `POST /v1/images/generations`. A credit plan still pays for an image
// request — at the per-image price the admin set — so existing customers keep
// working; an image plan simply takes precedence for image requests because it
// cannot be spent on anything else.
//
// PURE (no driver, no repo, no I/O): the admin form, the queue, the customer
// cards and the request path all read the same rules from here.
const KIND_LLM = "llm";
const KIND_IMAGE = "image";

/** `"image"` or (for anything unrecognised, including NULL on an old row) `"llm"`. */
export function normalizePlanKind(value) {
  return String(value ?? "").trim().toLowerCase() === KIND_IMAGE ? KIND_IMAGE : KIND_LLM;
}

export function isImagePlan(value) {
  return normalizePlanKind(value) === KIND_IMAGE;
}

/** `"Gói ảnh"` / `"Gói credit"` — the label the admin cards and API payloads use. */
export function planKindLabel(value) {
  return isImagePlan(value) ? "Gói ảnh" : "Gói credit";
}

/**
 * Integer count from anything numeric, floored at zero. Never NaN, never a float:
 * an image balance is a count, and half an image is not a thing.
 */
export function imageCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
