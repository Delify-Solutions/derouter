// Admin announcements to every linked customer (spec telegram-notify).
//
// One broadcast runs at a time, in the background, paced under Telegram's
// ~30 messages/second limit. Progress is written to telegramBroadcasts so the
// admin page can poll it. A broadcast cut short by a restart shows as
// "interrupted": nothing resumes it, so nobody gets the message twice.
// Relative imports only: tests import this module directly.

import crypto from "node:crypto";
import { getAdapter } from "../db/driver.js";
import { messages, notifyCustomer, parseNotifyPrefs } from "./customerTelegram.js";

export const MAX_BROADCAST_LENGTH = 3500;
const PACE_MS = 50; // ~20 messages/second
const PROGRESS_EVERY = 20;
const MAX_FLOOD_RETRIES = 3;
// Not delivery failures: the recipient's own choice or state changed mid-run.
// A refusal by Telegram (`blocked`) on this message counts as failed instead.
const SKIPPED = new Set(["opted_out", "inactive", "not_linked"]);

const g = (globalThis.__telegramBroadcast ??= { activeId: null });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Linked customers who keep announcements on and whom Telegram still delivers to. */
export function listBroadcastRecipientsSync(db) {
  return db
    .all(
      `SELECT id, telegramNotifyPrefs FROM users
        WHERE telegramUserId IS NOT NULL AND telegramDmBlockedAt IS NULL AND status = 'active'`
    )
    .filter((row) => parseNotifyPrefs(row.telegramNotifyPrefs).announcements)
    .map((row) => row.id);
}

/** Counts for the admin page: linked, reachable, and opted in to announcements. */
export function audienceStatsSync(db) {
  const linked = db.get(`SELECT COUNT(*) AS c FROM users WHERE telegramUserId IS NOT NULL`)?.c ?? 0;
  const blocked = db.get(
    `SELECT COUNT(*) AS c FROM users WHERE telegramUserId IS NOT NULL AND telegramDmBlockedAt IS NOT NULL`
  )?.c ?? 0;
  return { linked: Number(linked), blocked: Number(blocked), recipients: listBroadcastRecipientsSync(db).length };
}

export function listBroadcastsSync(db, { limit = 20 } = {}) {
  return db
    .all(`SELECT * FROM telegramBroadcasts ORDER BY createdAt DESC LIMIT ?`, [limit])
    .map((row) => ({
      ...row,
      status: row.status === "sending" && g.activeId !== row.id ? "interrupted" : row.status,
    }));
}

export function validateBroadcastText(text) {
  const value = String(text ?? "").trim();
  if (!value) return { ok: false, error: "Nội dung trống" };
  if (value.length > MAX_BROADCAST_LENGTH) return { ok: false, error: `Tối đa ${MAX_BROADCAST_LENGTH} ký tự` };
  return { ok: true, text: value };
}

/**
 * Create a broadcast and start sending it in the background.
 * @returns {Promise<{ ok: true, broadcast: object } | { ok: false, error: string, status: number }>}
 */
export async function startBroadcast({ text, createdBy = null }) {
  const checked = validateBroadcastText(text);
  if (!checked.ok) return { ok: false, error: checked.error, status: 400 };
  if (g.activeId) return { ok: false, error: "Đang gửi một thông báo khác, chờ xong rồi gửi tiếp", status: 409 };
  // Claimed before the first await, so two requests cannot both start.
  const id = crypto.randomUUID();
  g.activeId = id;

  let db;
  let recipients;
  try {
    db = await getAdapter();
    recipients = listBroadcastRecipientsSync(db);
  } catch (error) {
    g.activeId = null;
    throw error;
  }
  if (!recipients.length) {
    g.activeId = null;
    return { ok: false, error: "Chưa có khách nào nhận được thông báo", status: 400 };
  }

  const createdAt = new Date().toISOString();
  db.run(
    `INSERT INTO telegramBroadcasts(id, text, createdBy, createdAt, status, total, sent, failed, skipped, finishedAt)
     VALUES(?, ?, ?, ?, 'sending', ?, 0, 0, 0, NULL)`,
    [id, checked.text, createdBy, createdAt, recipients.length]
  );
  runBroadcast(db, id, checked.text, recipients).catch((error) => {
    console.error(`[broadcast] stopped: ${error?.message || "unknown error"}`);
  });
  return { ok: true, broadcast: db.get(`SELECT * FROM telegramBroadcasts WHERE id = ?`, [id]) };
}

async function runBroadcast(db, id, text, recipients, { pace = PACE_MS } = {}) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const build = messages.broadcast(text);
  const progress = () =>
    db.run(`UPDATE telegramBroadcasts SET sent = ?, failed = ?, skipped = ? WHERE id = ?`, [sent, failed, skipped, id]);
  try {
    for (let i = 0; i < recipients.length; i++) {
      let result = await notifyCustomer(recipients[i], "announcements", build);
      // Flood limit: wait as told, a few times, before giving up on this one.
      for (let tries = 0; result.reason === "rate_limited" && tries < MAX_FLOOD_RETRIES; tries++) {
        await sleep(Math.min(60, result.retryAfterSec || 1) * 1000);
        result = await notifyCustomer(recipients[i], "announcements", build);
      }
      if (result.ok) sent += 1;
      else if (SKIPPED.has(result.reason)) skipped += 1;
      else failed += 1;
      if ((i + 1) % PROGRESS_EVERY === 0) progress();
      if (pace) await sleep(pace);
    }
    db.run(
      `UPDATE telegramBroadcasts SET sent = ?, failed = ?, skipped = ?, status = 'done', finishedAt = ? WHERE id = ?`,
      [sent, failed, skipped, new Date().toISOString(), id]
    );
  } catch (error) {
    db.run(
      `UPDATE telegramBroadcasts SET sent = ?, failed = ?, skipped = ?, status = 'failed', finishedAt = ? WHERE id = ?`,
      [sent, failed, skipped, new Date().toISOString(), id]
    );
    throw error;
  } finally {
    g.activeId = null;
  }
}

/** Test seam: wait for the running broadcast to finish. */
export async function waitForBroadcastForTests(timeoutMs = 5000) {
  const start = Date.now();
  while (g.activeId && Date.now() - start < timeoutMs) await sleep(10);
}
