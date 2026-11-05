// Landing-page promo popup (spec promo-popup).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-popup-"));
process.env.DATA_DIR = tmpDir;

const popup = await import("../src/shared/utils/promoPopup.js");
const { mergeLandingCopy, LANDING_COPY_DEFAULTS } = await import("../src/lib/db/repos/contentRepo.js");
const { safeNext } = await import("../src/shared/utils/safeNext.js");

test("popup settings: defaults, bounds and a version that follows the content", () => {
  const off = popup.readPromoPopup(LANDING_COPY_DEFAULTS);
  assert.equal(off.enabled, false);
  assert.equal(off.delaySec, 3);
  assert.equal(off.repeatMinutes, 5);
  assert.equal(popup.promoPopupState(LANDING_COPY_DEFAULTS), "disabled");
  assert.equal(popup.promoPopupState({ popupEnabled: true }), "empty");

  const on = { popupEnabled: true, popupTitle: "Tặng $5", popupCode: " welcome ", popupDelaySec: "999", popupRepeatMinutes: "" };
  const read = popup.readPromoPopup(on);
  assert.equal(popup.promoPopupState(on), "live");
  assert.equal(read.code, "WELCOME");
  assert.equal(read.cta, "Đăng ký nhận ưu đãi");
  assert.equal(read.delaySec, popup.MAX_DELAY_SEC);
  assert.equal(read.repeatMinutes, 5);
  assert.notEqual(read.version, popup.readPromoPopup({ ...on, popupTitle: "Tặng $10" }).version);
  assert.equal(read.version, popup.readPromoPopup({ ...on, popupDelaySec: "5" }).version);
});

test("the button leads a visitor through sign-up to the gift page, a customer straight there", () => {
  assert.equal(popup.promoTargetHref("ab-cd 12", { signedIn: true }), "/account/gift?code=ABCD12");
  const visitor = popup.promoTargetHref("ABCD12");
  assert.equal(visitor, "/register?next=%2Faccount%2Fgift%3Fcode%3DABCD12");
  // The register form only follows a safe next; the gift link must be one.
  assert.equal(safeNext(decodeURIComponent(visitor.split("next=")[1])), "/account/gift?code=ABCD12");
  assert.equal(popup.promoTargetHref(""), "/register");
  assert.equal(popup.promoTargetHref("", { signedIn: true }), "/account");
});

test("a dismissal holds for the repeat window in minutes, only for the same content", () => {
  const now = Date.UTC(2026, 10, 3);
  const record = { version: "v1", at: now - 4 * 60_000 }; // closed 4 minutes ago
  assert.equal(popup.isPopupDismissed(record, "v1", 5, now), true, "still within 5 minutes");
  assert.equal(popup.isPopupDismissed(record, "v1", 3, now), false, "3-minute window has passed: shows again");
  assert.equal(popup.isPopupDismissed(record, "v2", 5, now), false, "new content shows at once");
  assert.equal(popup.isPopupDismissed(record, "v1", 0, now), false, "0 = every page load");
  assert.equal(popup.isPopupDismissed(null, "v1", 5, now), false);
});

test("the pending code survives sign-up, expires after a week and is cleared", () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  try {
    const now = Date.now();
    popup.savePendingGiftCode("wel-come", now);
    assert.equal(popup.readPendingGiftCode(now + 1000), "WELCOME");
    assert.equal(popup.readPendingGiftCode(now + popup.PENDING_GIFT_TTL_MS + 1), "");
    popup.clearPendingGiftCode();
    assert.equal(popup.readPendingGiftCode(now), "");
    store.set(popup.PENDING_GIFT_KEY, "{not json");
    assert.equal(popup.readPendingGiftCode(now), "");
  } finally {
    delete globalThis.window;
  }
  // No window (server render) or blocked storage: nothing throws.
  assert.equal(popup.readPendingGiftCode(), "");
  popup.savePendingGiftCode("X");
});

test("admin saves are validated: lengths, code charset, whole-number bounds", () => {
  const err = popup.popupFieldError;
  assert.equal(err("popupTitle", "x".repeat(120)), null);
  assert.match(err("popupTitle", "x".repeat(121)), /tối đa 120/);
  assert.match(err("popupBody", "x".repeat(601)), /tối đa 600/);
  assert.match(err("popupCode", "WEL COME"), /chữ, số và dấu gạch ngang/);
  assert.equal(err("popupCode", "wel-come-2026"), null);
  assert.equal(err("popupCode", ""), null);
  for (const bad of ["-1", "3.5", "1e3", "abc", "121"]) assert.match(err("popupDelaySec", bad), /0 đến 120/, bad);
  assert.equal(err("popupDelaySec", ""), null);
  assert.equal(err("popupDelaySec", "120"), null);
  assert.match(err("popupRepeatMinutes", "10081"), /0 đến 10080/);
  assert.equal(err("popupRepeatMinutes", "0"), null);
  assert.equal(err("heroTitle", "x".repeat(5000)), null); // not a popup key
  assert.equal(popup.storedPopupValue("popupCode", "  wel-come "), "WEL-COME");
  assert.equal(popup.storedPopupValue("popupTitle", " Hi "), " Hi ");
});

test("edge cases of parsing and links", () => {
  assert.equal(popup.readPromoPopup({ popupDelaySec: "-1" }).delaySec, 0);
  assert.equal(popup.readPromoPopup({ popupDelaySec: "2.6" }).delaySec, 3);
  assert.equal(popup.readPromoPopup({ popupEnabled: true, popupTitle: "Hi" }).cta, "Đăng ký ngay");
  assert.equal(popup.promoPopupState({ popupEnabled: true, popupTitle: "   ", popupBody: "\n" }), "empty");
  assert.equal(popup.normalizePromoCode("a".repeat(100)).length, 64);
  assert.equal(popup.giftPageHref(""), "/account/gift");
  assert.equal(popup.giftPageHref("<script>"), "/account/gift?code=SCRIPT");
});

test("stored copy keeps both booleans and drops wrong types", () => {
  const merged = mergeLandingCopy({ popupEnabled: true, bannerEnabled: "yes", popupTitle: 5, popupCode: "ABC" });
  assert.equal(merged.popupEnabled, true);
  assert.equal(merged.bannerEnabled, false);
  assert.equal(merged.popupTitle, "");
  assert.equal(merged.popupCode, "ABC");
});

test("a referral is merged into the promo popup, or shown alone", () => {
  const promoCopy = { popupEnabled: true, popupTitle: "Tặng $5", popupCode: "WELCOME", popupDelaySec: "3", popupRepeatMinutes: "5" };
  const referral = { code: "K7Q2MZ", bonus: { bp: 1000, maxOrders: 1 }, giftCode: "TELE-GIFT" };

  const merged = popup.combinePopup(promoCopy, referral);
  assert.equal(merged.title, "Tặng $5");
  assert.equal(merged.code, "WELCOME");
  assert.equal(merged.referral.code, "K7Q2MZ");
  assert.deepEqual(merged.referral.benefits, [
    "Tặng thêm 10% credit cho 1 đơn đầu đã thanh toán.",
    "Gói không giới hạn credit: giảm 10% ngay khi thanh toán.",
    "Mã quà chào mừng TELE-GIFT: liên kết Telegram rồi nhập ở trang Mã quà tặng.",
  ]);
  assert.notEqual(merged.version, popup.readPromoPopup(promoCopy).version, "closing the plain promo does not hide the referral one");

  const alone = popup.combinePopup({ popupEnabled: false }, referral);
  assert.equal(alone.title, "Bạn được mời dùng thử");
  assert.equal(alone.code, "");
  assert.equal(popup.combinePopup({ popupEnabled: false }, null), null);
  assert.equal(popup.combinePopup(promoCopy, null).title, "Tặng $5");

  assert.equal(popup.promoTargetHref("WELCOME", { refCode: "K7Q2MZ" }), "/register?ref=K7Q2MZ&next=%2Faccount%2Fgift%3Fcode%3DWELCOME");
  assert.equal(popup.promoTargetHref("", { refCode: "K7Q2MZ" }), "/register?ref=K7Q2MZ");
});

test("a referral that gives nothing is not announced", () => {
  const promoCopy = { popupEnabled: true, popupTitle: "Tặng $5", popupCode: "WELCOME" };
  const empty = { code: "K7Q2MZ", bonus: { bp: 0, maxOrders: 1 }, giftCode: null };
  assert.equal(popup.combinePopup({ popupEnabled: false }, empty), null, "no empty invitation dialog");
  const promo = popup.combinePopup(promoCopy, empty);
  assert.equal(promo.referral, undefined);
  assert.equal(promo.version, popup.readPromoPopup(promoCopy).version, "a closed promo is not re-shown");
});

test("benefit lines: every order, and fractional percents", () => {
  assert.deepEqual(popup.referralBenefits({ code: "X", bonus: { bp: 1250, maxOrders: 0 } }), [
    "Tặng thêm 12,5% credit cho mọi đơn đã thanh toán.",
    "Gói không giới hạn credit: giảm 12,5% ngay khi thanh toán.",
  ]);
  assert.deepEqual(popup.referralBenefits({ code: "X", giftCode: "HELLO" }), [
    "Mã quà chào mừng HELLO: liên kết Telegram rồi nhập ở trang Mã quà tặng.",
  ]);
});
