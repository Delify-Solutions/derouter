"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import ReasonModal from "./ReasonModal";

/**
 * "Người giới thiệu" on the user detail page (design D8/D9).
 *
 * Setting or clearing it is the only way an EXISTING account can be attributed,
 * and it never creates commission retroactively — the panel says so, because an
 * operator expecting a payout from the next order would be surprised. The change
 * needs a reason and is audited on the account.
 *
 * The affiliate summary below is read-only: balance per currency, and a link to
 * the affiliate row when the account has one.
 */
export default function ReferrerPanel({ user, onChanged }) {
  const [affiliate, setAffiliate] = useState(null);
  const [referrer, setReferrer] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [clear, setClear] = useState(false);
  const [error, setError] = useState("");

  // Destructured so the dependency list names the exact values the callback
  // reads: `user?.id` and `user?.referredByUserId` infer differently.
  const userId = user?.id || "";
  const referredByUserId = user?.referredByUserId || "";

  const load = useCallback(async () => {
    if (!userId) return;
    // The affiliate row is optional: most accounts referred someone without ever
    // opening the affiliate page, so a 404 is a normal answer.
    try {
      const res = await fetch(`/api/affiliates/${userId}`, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        setAffiliate(body);
      } else {
        setAffiliate(null);
      }
    } catch {
      setAffiliate(null);
    }

    const referrerId = referredByUserId;
    if (!referrerId) {
      setReferrer(null);
      return;
    }
    try {
      const res = await fetch(`/api/users/${referrerId}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      setReferrer(res.ok ? { id: referrerId, email: body.user?.email ?? referrerId } : { id: referrerId, email: referrerId });
    } catch {
      setReferrer({ id: referrerId, email: referrerId });
    }
  }, [userId, referredByUserId]);

  useEffect(() => { load(); }, [load]);

  // Search is over the same admin user list the page already uses; three characters
  // is enough to narrow it without hammering the endpoint on every keystroke.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) {
      setCandidates([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/users?q=${encodeURIComponent(term)}&pageSize=8`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { users: [] }))
        .then((body) => {
          if (!cancelled) setCandidates((body.users || []).filter((entry) => entry.id !== userId));
        })
        .catch(() => { if (!cancelled) setCandidates([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, userId]);

  const submit = async ({ reason }) => {
    setError("");
    const body = { referrerUserId: clear ? null : chosen?.id ?? null, reason };
    if (!clear && !body.referrerUserId) {
      return { ok: false, error: "Chọn người giới thiệu trước." };
    }
    try {
      const res = await fetch(`/api/users/${userId}/referrer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không đổi được người giới thiệu");
        return { ok: false, error: data.error || "Không đổi được người giới thiệu" };
      }
      setQuery("");
      setCandidates([]);
      setChosen(null);
      if (onChanged) await onChanged();
      return { ok: true };
    } catch {
      return { ok: false, error: "Không kết nối được máy chủ" };
    }
  };

  return (
    <section className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="meta text-text-muted">Người giới thiệu</h2>
          <p className="text-xs text-text-muted">
            Gán tay chỉ ghi nhận người giới thiệu. Hoa hồng tính từ đơn thanh toán tiếp theo của tài khoản này,
            không truy hồi đơn cũ.
          </p>
        </div>
        {referrer ? (
          <Button size="sm" variant="secondary" onClick={() => { setClear(true); setModalOpen(true); }}>
            Bỏ người giới thiệu
          </Button>
        ) : null}
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-text-muted">Hiện tại</dt>
          <dd className="font-mono text-[12px] text-text-main">
            {referrer ? (
              <Link href={`/dashboard/users/${referrer.id}`} className="underline underline-offset-4">
                {referrer.email}
              </Link>
            ) : "Chưa có"}
            {user.referredAt ? <span className="ml-2 text-text-subtle">{new Date(user.referredAt).toLocaleDateString("vi-VN")}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-text-muted">Hồ sơ CTV</dt>
          <dd className="font-mono text-[12px] text-text-main">
            {affiliate ? (
              <Link
                href={`/dashboard/affiliates?tab=affiliates&q=${encodeURIComponent(affiliate.affiliate?.code || "")}`}
                className="underline underline-offset-4"
              >
                {affiliate.affiliate?.code} · {affiliate.affiliate?.status === "blocked" ? "đã khóa" : "hoạt động"}
              </Link>
            ) : "Không có mã giới thiệu"}
          </dd>
        </div>
      </dl>

      {affiliate ? (
        <dl className="grid gap-3 border-t border-border pt-3 text-sm sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <dt className="text-text-muted">Ví VND</dt>
            <dd className="font-mono text-[12px] text-text-main">{formatVnd(affiliate.wallet?.VND?.available ?? 0)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-text-muted">Ví USD</dt>
            <dd className="font-mono text-[12px] text-text-main">{fmtUsdNano(affiliate.wallet?.USD?.available ?? 0)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-text-muted">Đang giữ</dt>
            <dd className="font-mono text-[12px] text-text-muted">
              {formatVnd(affiliate.wallet?.VND?.pending ?? 0)} · {fmtUsdNano(affiliate.wallet?.USD?.pending ?? 0)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-text-muted">Người được giới thiệu</dt>
            <dd className="font-mono text-[12px] text-text-muted">{affiliate.referrals?.length ?? 0}</dd>
          </div>
        </dl>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Input
          label="Đặt người giới thiệu"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setChosen(null); }}
          placeholder="Tìm theo email hoặc tên (ít nhất 3 ký tự)"
        />
        {chosen ? (
          <p className="font-mono text-[12px] text-text-main">
            Đã chọn: {chosen.email}
          </p>
        ) : null}
        {!chosen && candidates.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => { setChosen(candidate); setClear(false); setModalOpen(true); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="font-mono text-[12px] text-text-main">{candidate.email}</span>
                  <span className="text-xs text-text-muted">{candidate.displayName || "—"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        ) : null}
      </div>

      <ReasonModal
        isOpen={modalOpen}
        title={clear ? "Bỏ người giới thiệu" : "Đặt người giới thiệu"}
        description={clear ? "Tài khoản sẽ không còn được ghi nhận là do ai giới thiệu." : `Người giới thiệu: ${chosen?.email || ""}`}
        confirmLabel={clear ? "Bỏ" : "Đặt"}
        onClose={() => setModalOpen(false)}
        onConfirm={submit}
        values={{}}
      />
    </section>
  );
}
