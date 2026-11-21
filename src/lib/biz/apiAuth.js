// Shared guards for the customer business routes (design D13).
//
// Every `/api/account/biz/**` route needs the same three things: a customer
// session, one of THAT customer's bots (another customer's bot is a 404, never a
// 403 — the id space is not a directory), and the current business settings.
import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getOwnedBotSync } from "@/lib/db/repos/bizBotsRepo.js";
import { businessModelIds, getBusinessSettings } from "./settings.js";

export const NO_STORE = { "Cache-Control": "no-store" };

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
}

export function notFound(message = "Bot not found") {
  return NextResponse.json({ error: message }, { status: 404, headers: NO_STORE });
}

export function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
}

export function failure(message, status) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/**
 * Resolve `{ session, db, bot, business, businessModelIds }`, or one of the error
 * Responses. `botId` may be null for routes that only need the session.
 *
 * @returns {Promise<{ response?: Response } & Record<string, any>>}
 */
export async function withBot(request, { botId = null, requireBot = true } = {}) {
  const session = await resolveAccountUser(request);
  if (!session) return { response: unauthorized() };

  const db = await getAdapter();
  const business = await getBusinessSettings();
  if (!botId) {
    return { session, db, business, bot: null, businessModelIds: businessModelIds(business) };
  }
  const bot = requireBot ? getOwnedBotSync(db, session.userId, botId) : null;
  if (requireBot && !bot) return { response: notFound() };
  return { session, db, business, bot, businessModelIds: businessModelIds(business) };
}

/** Normalised integer from a query/body value, or null. */
export function intOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}
