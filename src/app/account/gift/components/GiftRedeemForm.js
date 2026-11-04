"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, Eyebrow, Stat } from "@/app/account/components/ui";
import { TelegramLinkPrompt } from "@/app/account/components/TelegramLink";
import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";
import { formatGiftCode, formatTypedGiftCode, normalizeGiftCode } from "./formatCode";
import { clearPendingGiftCode, readPendingGiftCode } from "@/shared/utils/promoPopup.js";

// Generated codes are grouped in fours once complete; admin-chosen codes stay as typed.
function formatAsTyped(raw) {
  return formatTypedGiftCode(raw);
}

function fmtWhen(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * `initialCode` is the referral welcome gift this account was brought in with
 * (design D7). It sits BELOW `?code=` and the pending popup code, which are
 * explicit choices the visitor just made, and above an empty field.
 */
export default function GiftRedeemForm({ onRedeemed, initialCode = "" }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);   // { ok: true, ... } | { error, needsTelegram? }
  const inputRef = useRef(null);

  // Prefill from ?code= (the promo popup's link), the code the visitor copied
  // from the popup before signing up (spec promo-popup), or the referral welcome
  // gift. Read from window rather than useSearchParams so the page needs no
  // Suspense boundary.
  useEffect(() => {
    let prefill = "";
    try {
      prefill = new URLSearchParams(window.location.search).get("code") || "";
    } catch {
      prefill = "";
    }
    if (!prefill) prefill = readPendingGiftCode();
    // Minted codes (16 characters) read best in fours; a hand-picked code such as
    // WELCOME2026 is shown as the popup showed it. Redemption ignores dashes.
    const key = normalizeGiftCode(prefill);
    if (key) setCode(formatGiftCode(key));
    inputRef.current?.focus();
  }, []);

  // The referral gift arrives after a fetch, possibly while the customer is
  // already typing. It only ever fills an EMPTY field, so it can neither replace
  // a ?code= / popup prefill nor overwrite what the customer typed.
  useEffect(() => {
    const key = normalizeGiftCode(initialCode || "");
    if (!key) return;
    setCode((current) => current || formatGiftCode(key));
  }, [initialCode]);

  const onChange = (event) => {
    setCode(formatAsTyped(event.target.value));
    if (result) setResult(null);
  };

  const redeem = useCallback(async (value) => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/account/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A new-user code on an account without Telegram: the one refusal the
        // customer can fix here. The code stays in the field for the retry.
        setResult({ error: data.error || "Không nhập được mã này.", needsTelegram: data.code === "telegram_required" });
        return;
      }
      setResult({ ok: true, ...data });
      setCode("");
      clearPendingGiftCode();
      // Drop ?code= so a reload does not refill a code that is already used.
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has("code")) {
          url.searchParams.delete("code");
          window.history.replaceState(null, "", url.pathname + url.search + url.hash);
        }
      } catch {
        /* ignore */
      }
      if (onRedeemed) onRedeemed();
    } catch {
      setResult({ error: "Không kết nối được máy chủ." });
    } finally {
      setPending(false);
    }
  }, [onRedeemed]);

  const submit = async (event) => {
    event.preventDefault();
    const key = code.replace(/[^A-Z0-9]/g, "");
    if (key.length < 4) {
      setResult({ error: "Nhập đầy đủ mã." });
      return;
    }
    await redeem(code);
  };

  // Linked from the prompt below: redeem the same code without another click.
  const onTelegramLinked = useCallback(() => { redeem(code); }, [redeem, code]);

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="gift-code"><Eyebrow>Mã quà tặng</Eyebrow></label>
        <input
          id="gift-code"
          ref={inputRef}
          value={code}
          onChange={onChange}
          disabled={pending}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="h-14 w-full border border-border bg-surface px-4 font-mono text-xl tracking-[0.18em] text-text-main placeholder-text-subtle transition-colors duration-150 focus:border-text-main focus:outline-none disabled:opacity-50"
        />
        <div>
          <ActionButton type="submit" tone="solid" loading={pending}>Nhập mã</ActionButton>
        </div>
      </form>

      {result?.error && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
          <span>{result.error}</span>
        </div>
      )}

      {result?.needsTelegram && <TelegramLinkPrompt onLinked={onTelegramLinked} />}

      {result?.ok && (
        <div role="status" className="flex flex-col gap-4 border border-brand-500/30 bg-brand-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-brand-700 dark:text-brand-400">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
            <span>Đã nhập mã</span>
          </div>
          <dl className="grid gap-5 sm:grid-cols-3">
            <Stat
              label="Đã cộng"
              value={result.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(result.creditAppliedNanoUsd ?? 0)}
              hint={
                (result.appliedToOverdraftNanoUsd ?? 0) > 0
                  ? `${fmtUsdNano(result.appliedToOverdraftNanoUsd)} trong số này đã trả khoản nợ của bạn trước.`
                  : null
              }
            />
            <Stat label="Gói" value={result.planName || "Cộng credit"} />
            <Stat label="Hết hạn" value={fmtWhen(result.expiresAt)} />
          </dl>
        </div>
      )}

      <p className="border-t border-border pt-4 text-sm text-text-muted">
        Mã chỉ dùng một lần và có thể hết hạn. Credit được cộng vào gói sắp hết hạn sớm nhất.
      </p>
    </div>
  );
}
