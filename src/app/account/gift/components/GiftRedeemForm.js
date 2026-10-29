"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
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
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
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
      setResult({ error: "Enter the full code." });
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
        setResult({ error: data.error || "Could not redeem this code." });
        return;
      }
      setResult({ ok: true, ...data });
      setCode("");
      if (onRedeemed) onRedeemed();
    } catch {
      setResult({ error: "Could not reach the server." });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label
          htmlFor="gift-code"
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted"
        >
          Code
        </label>
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
          className="h-14 w-full border border-border bg-surface px-4 font-mono text-xl tracking-[0.18em] text-text-main placeholder-text-subtle transition-colors duration-150 focus:border-brand-500 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="lg" loading={pending} disabled={pending}>
            Redeem
          </Button>
          <span className="text-xs text-text-muted">
            Dashes are optional — the code is read in any case.
          </span>
        </div>
      </form>

      {result?.error && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400"
        >
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{result.error}</span>
        </div>
      )}

      {result?.ok && (
        <div className="flex flex-col gap-2 border border-brand-500/30 bg-brand-500/10 px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-medium text-brand-700 dark:text-brand-400">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            <span>Đã nhập mã</span>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Đã cộng</dt>
              <dd className="mt-1 font-mono text-text-main">{fmtUsdNano(result.creditAppliedNanoUsd ?? 0)}</dd>
              {(result.appliedToOverdraftNanoUsd ?? 0) > 0 && (
                <dd className="mt-1 text-xs text-text-muted">
                  {fmtUsdNano(result.appliedToOverdraftNanoUsd)} of this repaid your outstanding balance first.
                </dd>
              )}
            </div>
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Gói</dt>
              <dd className="mt-1 font-mono text-text-main">{result.planName || "Cộng credit"}</dd>
            </div>
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Hết hạn</dt>
              <dd className="mt-1 font-mono text-text-main">{fmtWhen(result.expiresAt)}</dd>
            </div>
          </dl>
        </div>
      )}

      <p className="border-t border-border pt-3 text-xs text-text-muted">
        Gift codes are single-use and can expire. Codes are applied to the earliest-expiring plan first.
      </p>
    </div>
  );
}
