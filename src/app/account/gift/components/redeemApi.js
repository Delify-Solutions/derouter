"use client";

import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";

/**
 * POST /api/account/redeem. Never throws.
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string, code?: string, channelUrl?: string }>}
 */
export async function redeemGift(code) {
  try {
    const res = await fetch("/api/account/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || "Không nhập được mã này.",
        code: typeof data.code === "string" ? data.code : undefined,
        channelUrl: typeof data.channelUrl === "string" ? data.channelUrl : undefined,
      };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Không kết nối được máy chủ." };
  }
}

/** "$10.00 credit", "Pro · $20.00", "Không giới hạn" — what a code grants. */
export function grantText(grant) {
  if (!grant) return "";
  if (grant.unlimitedCredit) return grant.planName ? `${grant.planName} · ${UNLIMITED_CREDIT_LABEL}` : UNLIMITED_CREDIT_LABEL;
  const credit = fmtUsdNano(grant.creditNanoUsd ?? 0);
  return grant.planName ? `${grant.planName} · ${credit}` : `${credit} credit`;
}
