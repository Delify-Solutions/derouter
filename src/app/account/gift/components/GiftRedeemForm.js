"use client";

import { useEffect, useRef, useState } from "react";
import { ActionButton, Eyebrow, Stat } from "@/app/account/components/ui";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatGiftCode } from "./formatCode";

// Group in fours as the user types, matching the shape admin codes are minted in.
function formatAsTyped(raw) {
  return formatGiftCode(raw);
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

export default function GiftRedeemForm({ onRedeemed }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);   // { ok: true, ... } | { error }
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const onChange = (event) => {
    setCode(formatAsTyped(event.target.value));
    if (result) setResult(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    const key = code.replace(/[^A-Z0-9]/g, "");
    if (key.length < 4) {
      setResult({ error: "Nhập đầy đủ mã." });
      return;
    }

    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/account/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ error: data.error || "Không nhập được mã này." });
        return;
      }
      setResult({ ok: true, ...data });
      setCode("");
      if (onRedeemed) onRedeemed();
    } catch {
      setResult({ error: "Không kết nối được máy chủ." });
    } finally {
      setPending(false);
    }
  };

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

      {result?.ok && (
        <div role="status" className="flex flex-col gap-4 border border-brand-500/30 bg-brand-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-brand-700 dark:text-brand-400">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
            <span>Đã nhập mã</span>
          </div>
          <dl className="grid gap-5 sm:grid-cols-3">
            <Stat
              label="Đã cộng"
              value={fmtUsdNano(result.creditAppliedNanoUsd ?? 0)}
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
