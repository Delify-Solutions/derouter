// The business pipeline: everything a bot-key request goes through before a byte
// reaches the client (spec business-guard, design D4).
//
//   classify → guarded reply | retrieve → locked prompt → dispatch (non-streaming)
//            → output check → format
//
// It fails CLOSED. A missing guard or embedding model, a failed guard call, a
// failed embedding call and an unparseable verdict all answer 503
// `guard_unavailable`; there is no path where model text reaches a bot's client
// without passing the output check.
//
// The model call itself is `dispatch`, a closure over the normal combo path: usage,
// admission, combo pricing and request details all happen exactly as for any other
// router request, so the charge equals a normal combo charge.
import { getAdapter } from "../db/driver.js";
import { payingRatesSync } from "../billing/rates.js";
import { hitLimit } from "../auth/actionLimiter.js";
import { platformErrorResponse, PLATFORM_MESSAGES } from "../auth/platformError.js";
import { recordGuardEventSync } from "../db/repos/bizDocumentsRepo.js";
import { businessReady, getBusinessSettings } from "./settings.js";
import { classifyInput, checkOutput, latestUserText } from "./guard.js";
import { normalizeMessages, buildModelBody } from "./prompt.js";
import { formatReply, guardedReplyText, readCompletionText } from "./reply.js";
import { retrieve } from "./retrieval.js";
import { isGuardUnavailable } from "./internalCall.js";

/** Guarded replies allowed per bot key when its paying plan sets no RPM. */
export const GUARDED_REPLY_LIMIT = 60;

export function guardUnavailableResponse() {
  return platformErrorResponse({
    status: 503,
    code: "guard_unavailable",
    message: PLATFORM_MESSAGES.guard_unavailable,
  });
}

/** First 200 characters of the user message, for the event log. */
function excerpt(messages) {
  const text = latestUserText(messages).trim();
  return text.length > 200 ? text.slice(0, 200) : text;
}

function recordEvent(db, { bot, key, category, messages }) {
  try {
    recordGuardEventSync(db, {
      botId: bot.id,
      apiKeyId: key?.id ?? null,
      category,
      excerpt: excerpt(messages),
    });
  } catch {
    /* logging must never break a reply */
  }
}

/**
 * Count one guarded reply against the bot key's in-process window.
 * The limit is the paying business plan's RPM, or 60 when the plan sets none.
 */
async function guardedReplyAllowed(key) {
  if (!key?.userId) return { allowed: true };
  let rpm = null;
  try {
    const db = await getAdapter();
    const rates = payingRatesSync(db, key.userId, null, { planId: key.planId ?? null, productLine: "business" });
    rpm = Number(rates.rpm) > 0 ? Number(rates.rpm) : null;
  } catch {
    rpm = null;
  }
  const limit = rpm ?? GUARDED_REPLY_LIMIT;
  return hitLimit(`biz-guard:${key.id}`, { limit, windowMs: 60_000 });
}

function rateLimitResponse(retryAfterSec) {
  return platformErrorResponse({
    status: 429,
    code: "rate_limit",
    message: PLATFORM_MESSAGES.rate_limit_rpm,
    retryAfterSec,
  });
}

/**
 * Run one bot request.
 *
 * @param {object} args
 *   `{ body, auth, dispatch, stream, signal, callChat, embed }`
 *   `auth` is the object `getApiKeyForAuth` returned (its `bot` is the bot row's
 *   switch), `dispatch(bodyForModel)` performs the model call and returns the
 *   upstream Response.
 * @returns {Promise<Response>}
 */
export async function runBusinessPipeline({
  body,
  auth,
  dispatch,
  stream = false,
  callChat = null,
  embed = null,
} = {}) {
  const key = auth?.key;
  const botId = key?.botId;
  if (!botId) return platformErrorResponse({ status: 403, code: "bot_disabled", message: PLATFORM_MESSAGES.bot_disabled });

  const db = await getAdapter();

  const botRow = db.get(`SELECT * FROM bizBots WHERE id = ?`, [botId]);
  if (!botRow || botRow.userId !== key.userId) {
    return platformErrorResponse({ status: 403, code: "bot_disabled", message: PLATFORM_MESSAGES.bot_disabled });
  }
  const bot = {
    id: botRow.id,
    userId: botRow.userId,
    name: botRow.name,
    companyName: botRow.companyName,
    domainDescription: botRow.domainDescription,
    mode: botRow.mode === "flexible" ? "flexible" : "strict",
    refusalMessage: botRow.refusalMessage,
    extraInstructions: botRow.extraInstructions ?? "",
    modelId: botRow.modelId,
    isActive: botRow.isActive === 1 || botRow.isActive === true,
  };
  if (!bot.isActive) {
    return platformErrorResponse({ status: 403, code: "bot_disabled", message: PLATFORM_MESSAGES.bot_disabled });
  }

  const business = await getBusinessSettings();
  // Spec "Fail-closed availability": an unconfigured guard answers 503, never the
  // model's raw text.
  if (!businessReady(business)) return guardUnavailableResponse();

  const model = body?.model ?? bot.modelId;
  const streamWanted = stream === true || body?.stream === true;
  const { messages, instructions } = normalizeMessages(body);

  // ── 1. Classify ───────────────────────────────────────────────────────────
  let classification;
  try {
    classification = await classifyInput({
      bot,
      messages,
      guardModel: business.guardModel,
      ...(callChat ? { callChat } : {}),
    });
  } catch (error) {
    if (isGuardUnavailable(error)) {
      recordEvent(db, { bot, key, category: "guard_unavailable", messages });
      return guardUnavailableResponse();
    }
    return guardUnavailableResponse();
  }

  const blocked = guardedReplyText(classification.category, { bot, business });
  if (blocked != null) {
    const gate = await guardedReplyAllowed(key);
    if (!gate.allowed) return rateLimitResponse(gate.retryAfterSec);
    recordEvent(db, { bot, key, category: classification.category, messages });
    return formatReply({ text: blocked, model, stream: streamWanted, category: classification.category });
  }

  // ── 2. Retrieve ───────────────────────────────────────────────────────────
  let chunks = [];
  try {
    chunks = await retrieve({
      botId: bot.id,
      question: latestUserText(messages),
      embeddingModel: business.embeddingModel,
      threshold: business.relevanceThreshold,
      ...(embed ? { embed } : {}),
    });
  } catch (error) {
    if (isGuardUnavailable(error)) {
      recordEvent(db, { bot, key, category: "guard_unavailable", messages });
      return guardUnavailableResponse();
    }
    return guardUnavailableResponse();
  }

  // A strict bot answers only from its documents: no context, no model call, and
  // therefore nothing charged (spec "Strict mode without documents").
  if (bot.mode === "strict" && chunks.length === 0) {
    const gate = await guardedReplyAllowed(key);
    if (!gate.allowed) return rateLimitResponse(gate.retryAfterSec);
    recordEvent(db, { bot, key, category: "strict_no_context", messages });
    return formatReply({
      text: bot.refusalMessage,
      model,
      stream: streamWanted,
      category: "offtopic",
    });
  }

  // ── 3. Call the model through the normal router path ──────────────────────
  const modelBody = buildModelBody({ body, bot, chunks, instructions });
  modelBody.model = model;
  modelBody.stream = false;

  const upstream = await dispatch(modelBody);
  // Upstream errors pass through untouched, exactly as the normal path returns them
  // (their body is not read here, so it is still intact for the client).
  if (!upstream || !upstream.ok) return upstream;

  const { data, text } = await readCompletionText(upstream);
  // A 2xx whose body is not a completion this pipeline can read is NOT forwarded:
  // its text never passed the output check. Fail closed, as for any other guard
  // gap (spec business-guard "Fail-closed availability").
  if (typeof text !== "string") {
    recordEvent(db, { bot, key, category: "guard_unavailable", messages });
    return guardUnavailableResponse();
  }

  // ── 4. Output check ───────────────────────────────────────────────────────
  let verdict;
  try {
    verdict = await checkOutput({
      answer: text,
      bot,
      business,
      guardModel: business.guardModel,
      ...(callChat ? { callChat } : {}),
    });
  } catch (error) {
    // The model call already happened and is charged; the customer still gets no
    // unchecked text.
    if (isGuardUnavailable(error)) {
      recordEvent(db, { bot, key, category: "guard_unavailable", messages });
      return guardUnavailableResponse();
    }
    return guardUnavailableResponse();
  }

  if (verdict.verdict === "violation") {
    const category = verdict.category ?? "offtopic";
    const replacement = guardedReplyText(category, { bot, business }) ?? bot.refusalMessage;
    recordEvent(db, { bot, key, category: `output_${category}`, messages });
    return formatReply({
      text: replacement,
      model,
      stream: streamWanted,
      category: `output_${category}`,
    });
  }

  // ── 5. Format ─────────────────────────────────────────────────────────────
  // A real model answer reports the usage the model call actually had; only a
  // GUARDED reply is free (spec business-guard "Guarded replies").
  return formatReply({ text, model, stream: streamWanted, usage: data?.usage ?? null });
}
