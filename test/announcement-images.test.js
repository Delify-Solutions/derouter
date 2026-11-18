// An announcement can carry one image: shown on the web, sent as a Telegram photo.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-ann-image-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const { sendTelegramPhoto } = await import("../src/lib/notify/telegramApi.js");
const notify = await import("../src/lib/notify/customerTelegram.js");
const broadcast = await import("../src/lib/notify/broadcast.js");
const inbox = await import("../src/lib/notify/inbox.js");
const img = await import("../src/lib/notify/announcementImage.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let db;
let texts = [];
let photos = [];
let photoReply = () => ({ ok: true, fileId: "FILE-1" });

before(async () => {
  db = await getAdapter();
  await updateSettings({ telegramBotToken: "123:test", siteName: "derouter" });
  notify.setTelegramTransportForTests(async (token, chatId, text) => {
    texts.push({ chatId, text });
    return { ok: true };
  });
  notify.setTelegramPhotoTransportForTests(async (token, chatId, photo, caption) => {
    photos.push({ chatId, photo, caption });
    return photoReply(chatId, photo);
  });
});
after(() => {
  notify.setTelegramTransportForTests(null);
  notify.setTelegramPhotoTransportForTests(null);
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["users", "telegramBroadcasts", "announcements"]) db.run(`DELETE FROM ${table}`);
  texts = [];
  photos = [];
  photoReply = () => ({ ok: true, fileId: "FILE-1" });
});

function user(id, telegram) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt, telegramUserId)
     VALUES(?, ?, 'x', 'active', 0, ?, ?, ?)`,
    [id, `${id}@test.local`, now, now, telegram]
  );
}

test("only JPEG, PNG and WebP pass, detected from the bytes", () => {
  assert.equal(img.detectImageType(PNG), "image/png");
  assert.equal(img.detectImageType(JPEG), "image/jpeg");
  assert.equal(img.detectImageType(WEBP), "image/webp");
  assert.equal(img.detectImageType(SVG), null);
  assert.equal(img.detectImageType(Buffer.from("GIF89a" + "x".repeat(20))), null);
  assert.ok(img.validateAnnouncementImage(SVG).error);
  assert.ok(img.validateAnnouncementImage(Buffer.alloc(0)).error);
  const big = Buffer.concat([PNG, Buffer.alloc(img.ANNOUNCEMENT_IMAGE_MAX_BYTES)]);
  assert.equal(img.validateAnnouncementImage(big).error, "Ảnh tối đa 5 MB");
  assert.deepEqual(img.validateAnnouncementImage(PNG).value.type, "image/png");
});

test("files are stored by announcement id only; anything else is refused", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  img.saveAnnouncementImage(id, PNG);
  assert.deepEqual(img.readAnnouncementImage(id), PNG);
  img.removeAnnouncementImage(id);
  assert.equal(img.readAnnouncementImage(id), null);
  assert.throws(() => img.saveAnnouncementImage("../../etc/passwd", PNG));
  assert.equal(img.readAnnouncementImage("../machine-id"), null);
});

test("a multipart save request yields the fields and a checked image", async () => {
  const form = new FormData();
  form.append("title", "T");
  form.append("body", "B");
  form.append("important", "true");
  form.append("sendTelegram", "true");
  form.append("image", new Blob([PNG], { type: "image/png" }), "a.png");
  const read = await img.readAnnouncementRequest(new Request("http://x/api/announcements", { method: "POST", body: form }));
  assert.deepEqual(read.fields, { title: "T", body: "B", important: true, sendTelegram: true, removeImage: false });
  assert.equal(read.image.type, "image/png");

  // the declared type does not matter, the bytes do
  const bad = new FormData();
  bad.append("title", "T");
  bad.append("image", new Blob([SVG], { type: "image/png" }), "a.png");
  const refused = await img.readAnnouncementRequest(new Request("http://x", { method: "POST", body: bad }));
  assert.equal(refused.error, "Chỉ nhận ảnh JPG, PNG hoặc WebP");

  // JSON stays accepted, without an image
  const json = await img.readAnnouncementRequest(new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "T", body: "B" }),
  }));
  assert.equal(json.image, null);
  assert.equal(json.fields.title, "T");
});

test("the announcement row says whether it has an image", () => {
  const a = inbox.createAnnouncementSync(db, { title: "T", body: "B", important: false });
  assert.equal(a.hasImage, false);
  inbox.setAnnouncementImageSync(db, a.id, "image/png");
  assert.equal(inbox.announcementImageTypeSync(db, a.id), "image/png");
  assert.equal(inbox.listAnnouncementsSync(db).rows[0].hasImage, true);
  inbox.setAnnouncementImageSync(db, a.id, null);
  assert.equal(inbox.announcementImageTypeSync(db, a.id), null);
});

test("sendTelegramPhoto uploads once as multipart, then reuses the file id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: { photo: [{ file_id: "small" }, { file_id: "large" }] } }), { status: 200 });
  };
  const up = await sendTelegramPhoto("tok", 42, { buffer: PNG, type: "image/png" }, "<b>hi</b>", { fetchImpl });
  assert.deepEqual(up, { ok: true, fileId: "large" });
  assert.ok(calls[0].url.endsWith("/sendPhoto"));
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("parse_mode"), "HTML");
  assert.equal(calls[0].init.body.get("caption"), "<b>hi</b>");
  assert.equal(calls[0].init.body.get("chat_id"), "42");

  await sendTelegramPhoto("tok", 43, { fileId: "large" }, "", { fetchImpl });
  const sent = JSON.parse(calls[1].init.body);
  assert.deepEqual(sent, { chat_id: "43", photo: "large" });

  const status = (code, description) => async () => new Response(JSON.stringify({ ok: false, description }), { status: code });
  assert.equal((await sendTelegramPhoto("tok", 1, { fileId: "x" }, "", { fetchImpl: status(403, "Forbidden: bot was blocked") })).blocked, true);
  assert.equal(
    (await sendTelegramPhoto("tok", 1, { fileId: "x" }, "", { fetchImpl: status(400, "Bad Request: PHOTO_INVALID_DIMENSIONS") })).reason,
    "photo_rejected"
  );
});

test("a short announcement goes out as one photo with the text as its caption", async () => {
  user("u1", "1001");
  const photo = { buffer: PNG, type: "image/png" };
  const result = await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast("Bảo trì 23:00"), { photo });
  assert.equal(result.ok, true);
  assert.equal(photos.length, 1);
  assert.equal(texts.length, 0);
  assert.match(photos[0].caption, /Bảo trì 23:00/);
  assert.equal(photos[0].photo.buffer, PNG);
  assert.equal(photo.fileId, "FILE-1", "the file id is kept for the next recipient");
});

test("a text past the caption limit follows the photo as its own message", async () => {
  user("u1", "1001");
  const long = "x".repeat(1500);
  await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast(long), { photo: { buffer: PNG, type: "image/png" } });
  assert.equal(photos.length, 1);
  assert.equal(photos[0].caption, "");
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /x{1500}/);
});

test("a photo Telegram refuses is dropped: that recipient and the rest get the text", async () => {
  user("u1", "1001");
  user("u2", "1002");
  photoReply = () => ({ ok: false, reason: "photo_rejected" });
  const photo = { buffer: PNG, type: "image/png" };
  const build = notify.messages.broadcast("hi");
  assert.equal((await notify.notifyCustomer("u1", "announcements", build, { photo })).ok, true);
  assert.equal((await notify.notifyCustomer("u2", "announcements", build, { photo })).ok, true);
  assert.equal(photos.length, 1, "not tried again after the refusal");
  assert.deepEqual(texts.map((t) => t.chatId), ["1001", "1002"]);
});

test("a broadcast with a photo uploads it once and sends the file id to everyone else", async () => {
  user("u1", "1001");
  user("u2", "1002");
  user("u3", "1003");
  const started = await broadcast.startBroadcast({ text: "Khuyến mãi", photo: { buffer: JPEG, type: "image/jpeg" } });
  assert.equal(started.ok, true);
  assert.equal(started.broadcast.hasPhoto, 1);
  await broadcast.waitForBroadcastForTests();
  assert.equal(photos.length, 3);
  assert.equal(photos.filter((p) => p.photo.buffer).length, 1, "one upload");
  assert.equal(photos.filter((p) => p.photo.fileId === "FILE-1").length, 2);
  const row = db.get(`SELECT status, sent FROM telegramBroadcasts WHERE id = ?`, [started.broadcast.id]);
  assert.deepEqual({ ...row }, { status: "done", sent: 3 });
});

test("a follow-up text stuck on the flood limit never makes the caller resend the photo", async () => {
  user("u1", "1001");
  notify.setTelegramTransportForTests(async (token, chatId, text) => {
    texts.push({ chatId, text });
    return { ok: false, reason: "rate_limited", retryAfterSec: 0.001 };
  });
  try {
    const result = await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast("y".repeat(1500)), {
      photo: { buffer: PNG, type: "image/png" },
    });
    assert.equal(photos.length, 1);
    assert.equal(texts.length, 4, "the text alone is retried");
    assert.notEqual(result.reason, "rate_limited", "the broadcast loop must not retry the pair");
    assert.equal(result.ok, false);
  } finally {
    notify.setTelegramTransportForTests(async (token, chatId, text) => {
      texts.push({ chatId, text });
      return { ok: true };
    });
  }
});

test("the caption limit counts the header and the decoded text", async () => {
  user("u1", "1001");
  const header = "derouter · Thông báo\n";
  const fits = "a".repeat(1024 - header.length);
  await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast(fits), { photo: { buffer: PNG, type: "image/png" } });
  assert.equal(texts.length, 0, "exactly 1024 characters is still a caption");
  // "&" is escaped to "&amp;" in the HTML but counts as one character
  photos = [];
  await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast("&".repeat(1024 - header.length)), {
    photo: { buffer: PNG, type: "image/png" },
  });
  assert.equal(texts.length, 0);
  photos = [];
  await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast(fits + "b"), { photo: { buffer: PNG, type: "image/png" } });
  assert.equal(photos[0].caption, "");
  assert.equal(texts.length, 1);
});

test("only a refusal of the photo itself drops it for everyone", async () => {
  const status = (description) => async () => new Response(JSON.stringify({ ok: false, description }), { status: 400 });
  for (const d of ["Bad Request: PHOTO_INVALID_DIMENSIONS", "Bad Request: IMAGE_PROCESS_FAILED", "Bad Request: wrong file identifier/HTTP URL specified"]) {
    assert.equal((await sendTelegramPhoto("tok", 1, { fileId: "x" }, "", { fetchImpl: status(d) })).reason, "photo_rejected", d);
  }
  const perChat = await sendTelegramPhoto("tok", 1, { fileId: "x" }, "", {
    fetchImpl: status("Bad Request: not enough rights to send photos to the chat"),
  });
  assert.equal(perChat.reason, "telegram_error");
});

test("a broadcast whose photo was refused is not listed as carrying one", async () => {
  user("u1", "1001");
  photoReply = () => ({ ok: false, reason: "photo_rejected" });
  const started = await broadcast.startBroadcast({ text: "hi", photo: { buffer: PNG, type: "image/png" } });
  await broadcast.waitForBroadcastForTests();
  const row = db.get(`SELECT hasPhoto, sent FROM telegramBroadcasts WHERE id = ?`, [started.broadcast.id]);
  assert.deepEqual({ ...row }, { hasPhoto: 0, sent: 1 });
});

test("an oversized upload is refused from its Content-Length, before the body is read", async () => {
  let read = false;
  const request = {
    headers: new Headers({ "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) }),
    formData: async () => { read = true; return new FormData(); },
  };
  assert.equal((await img.readAnnouncementRequest(request)).error, "Ảnh tối đa 5 MB");
  assert.equal(read, false);
});
