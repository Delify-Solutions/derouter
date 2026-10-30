"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  Button,
  Input,
  Select,
  Modal,
  ConfirmModal,
  Badge,
  CardSkeleton,
} from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { fmtUsdNano, fmtCreditNano, usdToNano } from "@/shared/utils/money";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "exhausted", label: "Exhausted" },
];

function nowMs() {
  return Date.now();
}

function ts(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function fmtDate(value) {
  const ms = ts(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtDateTime(value) {
  const ms = ts(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function giftStatus(gift) {
  if (!gift.isActive) return "disabled";
  const expires = ts(gift.expiresAt);
  if (expires !== null && expires < nowMs()) return "expired";
  if ((gift.redeemedCount ?? 0) >= (gift.maxRedemptions ?? 1)) return "exhausted";
  const starts = ts(gift.startsAt);
  if (starts !== null && starts > nowMs()) return "scheduled";
  return "active";
}

function statusBadge(status) {
  if (status === "active") return <Badge variant="success" dot>Active</Badge>;
  if (status === "exhausted") return <Badge variant="info" dot>Exhausted</Badge>;
  if (status === "expired") return <Badge variant="warning" dot>Expired</Badge>;
  if (status === "scheduled") return <Badge variant="info" dot>Scheduled</Badge>;
  return <Badge variant="default" dot>Disabled</Badge>;
}

function grantLabel(gift) {
  if (gift.grantKind === "plan") {
    return gift.planName || gift.planId || "Plan";
  }
  return fmtUsdNano(gift.creditNanoUsd ?? 0);
}

function matchesFilter(gift, filter) {
  if (filter === "all") return true;
  const status = giftStatus(gift);
  if (filter === "active") return status === "active" || status === "scheduled";
  if (filter === "disabled") return status === "disabled" || status === "expired";
  if (filter === "exhausted") return status === "exhausted";
  return true;
}

// Local date input → end of that day in ISO, so "expires 2026-03-01" means the
// whole of the 1st, not midnight at its start.
function dateInputToExpiryIso(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

export default function GiftCodesPageClient() {
  const [codes, setCodes] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [createdCode, setCreatedCode] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [redemptionsFor, setRedemptionsFor] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [redemptionsError, setRedemptionsError] = useState("");
  const [rowBusyId, setRowBusyId] = useState(null);

  const { copied, copy } = useCopyToClipboard(2000);

  const fetchCodes = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/gift-codes");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Could not load gift codes.");
        return;
      }
      setCodes(Array.isArray(data.codes) ? data.codes : []);
      setPlans(Array.isArray(data.plans) ? data.plans : []);
    } catch {
      setLoadError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const visible = useMemo(() => codes.filter((g) => matchesFilter(g, filter)), [codes, filter]);

  const openCreate = () => {
    setCreateOpen(true);
  };

  const toggleActive = async (gift) => {
    setRowBusyId(gift.id);
    setLoadError("");
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !gift.isActive }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Could not update the code.");
        return;
      }
      setCodes((prev) => prev.map((g) => (g.id === gift.id ? data.code : g)));
    } catch {
      setLoadError("Could not reach the server.");
    } finally {
      setRowBusyId(null);
    }
  };

  const disableCode = async () => {
    const gift = confirmState?.gift;
    if (!gift) return;
    setRowBusyId(gift.id);
    setLoadError("");
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Could not disable the code.");
        return;
      }
      setCodes((prev) => prev.map((g) => (g.id === gift.id ? { ...g, isActive: false } : g)));
      setConfirmState(null);
    } catch {
      setLoadError("Could not reach the server.");
    } finally {
      setRowBusyId(null);
    }
  };

  const openRedemptions = async (gift) => {
    setRedemptionsFor(gift);
    setRedemptions([]);
    setRedemptionsError("");
    setRedemptionsLoading(true);
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}/redemptions`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRedemptionsError(data.error || "Could not load redemptions.");
        return;
      }
      setRedemptions(Array.isArray(data.redemptions) ? data.redemptions : []);
    } catch {
      setRedemptionsError("Could not reach the server.");
    } finally {
      setRedemptionsLoading(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-8 px-1 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-muted">Access</span>
          <h1 className="text-2xl font-semibold tracking-tight text-text-main">Gift codes</h1>
          <p className="max-w-xl text-sm text-text-muted">
            Codes grant a plan or a credit balance when a user redeems one. Disabling a code keeps its redemption
            history.
          </p>
        </div>
        <Button icon="add" onClick={openCreate}>New code</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            aria-pressed={filter === f.value}
            className={`h-8 border px-3 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-150 ${
              filter === f.value
                ? "border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-400"
                : "border-border text-text-muted hover:border-text-subtle hover:text-text-main"
            }`}
          >
            {f.label}
            <span className="ml-2 text-text-subtle">
              {codes.filter((g) => matchesFilter(g, f.value)).length}
            </span>
          </button>
        ))}
      </div>

      {loadError && (
        <div className="flex items-start gap-2 border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span className="flex-1">{loadError}</span>
          <Button size="sm" variant="ghost" onClick={fetchCodes}>Retry</Button>
        </div>
      )}

      {loading ? (
        <CardSkeleton />
      ) : visible.length === 0 ? (
        <Card className="flex flex-col items-start gap-3">
          <span className="material-symbols-outlined text-[22px] text-text-muted">redeem</span>
          <p className="text-sm text-text-main">
            {codes.length === 0 ? "No gift codes yet." : "No codes match this filter."}
          </p>
          <p className="text-sm text-text-muted">
            {codes.length === 0
              ? "Create a code to grant a plan or a credit balance to the users who redeem it."
              : "Choose another filter to see the rest."}
          </p>
          {codes.length === 0 && <Button variant="secondary" icon="add" onClick={openCreate}>New code</Button>}
        </Card>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="meta px-4 py-3 text-text-muted">Code</th>
                <th className="meta px-4 py-3 text-text-muted">Grant</th>
                <th className="meta px-4 py-3 text-text-muted">Redeemed</th>
                <th className="meta px-4 py-3 text-text-muted">Validity</th>
                <th className="meta px-4 py-3 text-text-muted">Status</th>
                <th className="meta px-4 py-3 text-right text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((gift) => {
                const status = giftStatus(gift);
                const busy = rowBusyId === gift.id;
                return (
                  <tr key={gift.id} className="border-b border-border last:border-b-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm tracking-wider text-text-main">
                          {gift.displayCode || gift.code}
                        </span>
                        <button
                          type="button"
                          onClick={() => copy(gift.displayCode || gift.code, gift.id)}
                          aria-label={`Copy code ${gift.displayCode || gift.code}`}
                          className="flex size-7 items-center justify-center border border-border text-text-muted transition-colors duration-150 hover:border-brand-500 hover:text-brand-600"
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            {copied === gift.id ? "check" : "content_copy"}
                          </span>
                        </button>
                      </div>
                      {gift.note && <p className="mt-1 text-xs text-text-subtle">{gift.note}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-text-main">{grantLabel(gift)}</span>
                      {gift.grantKind === "credit" && gift.durationDays ? (
                        <p className="text-xs text-text-subtle">{gift.durationDays} days</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-text-main">
                        {gift.redeemedCount ?? 0} / {gift.maxRedemptions ?? 1}
                      </span>
                      <p className="text-xs text-text-subtle">per user {gift.perUserLimit ?? 1}</p>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-mono text-xs text-text-muted">
                        {gift.startsAt && gift.expiresAt
                          ? `${fmtDate(gift.startsAt)} → ${fmtDate(gift.expiresAt)}`
                          : gift.expiresAt
                            ? `Until ${fmtDate(gift.expiresAt)}`
                            : gift.startsAt
                              ? `From ${fmtDate(gift.startsAt)}`
                              : "No expiry"}
                      </span>
                    </td>
                    <td className="px-4 py-3">{statusBadge(status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gift.isActive}
                          aria-label={gift.isActive ? "Disable code" : "Enable code"}
                          disabled={busy}
                          onClick={() => toggleActive(gift)}
                          className={`h-6 w-11 shrink-0 border transition-colors duration-150 ${
                            gift.isActive
                              ? "border-brand-500 bg-brand-500/20"
                              : "border-border bg-surface-2"
                          } ${busy ? "opacity-50" : ""}`}
                        >
                          <span
                            className={`block size-4 bg-text-main transition-transform duration-150 ${
                              gift.isActive ? "translate-x-6" : "translate-x-1"
                            }`}
                          />
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="list_alt"
                          onClick={() => openRedemptions(gift)}
                        >
                          Redemptions
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="block"
                          disabled={!gift.isActive || busy}
                          onClick={() => setConfirmState({ gift })}
                        >
                          Disable
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <NewGiftCodeModal
          plans={plans}
          onClose={() => setCreateOpen(false)}
          onCreated={async (code) => {
            setCreateOpen(false);
            setCreatedCode(code);
            await fetchCodes();
          }}
        />
      )}

      <Modal
        isOpen={Boolean(createdCode)}
        onClose={() => setCreatedCode(null)}
        title="Code created"
        size="md"
        footer={<Button onClick={() => setCreatedCode(null)}>Done</Button>}
      >
        {createdCode && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">
              Share this code with whoever should redeem it. It stays visible in the list below.
            </p>
            <div className="flex items-stretch border border-border bg-surface-2">
              <span className="flex flex-1 items-center px-4 py-4 font-mono text-lg tracking-[0.12em] text-text-main break-all">
                {createdCode.displayCode || createdCode.code}
              </span>
              <button
                type="button"
                onClick={() => copy(createdCode.displayCode || createdCode.code, "created")}
                aria-label="Copy created code"
                className="flex w-14 shrink-0 items-center justify-center border-l border-border text-text-muted transition-colors duration-150 hover:border-brand-500 hover:text-brand-600"
              >
                <span className="material-symbols-outlined text-[20px]">
                  {copied === "created" ? "check" : "content_copy"}
                </span>
              </button>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="meta text-text-muted">Grant</dt>
                <dd className="mt-1 font-mono text-text-main">{grantLabel(createdCode)}</dd>
              </div>
              <div>
                <dt className="meta text-text-muted">Redemptions</dt>
                <dd className="mt-1 font-mono text-text-main">
                  {createdCode.redeemedCount ?? 0} / {createdCode.maxRedemptions ?? 1}
                </dd>
              </div>
              <div>
                <dt className="meta text-text-muted">Per user</dt>
                <dd className="mt-1 font-mono text-text-main">{createdCode.perUserLimit ?? 1}</dd>
              </div>
              <div>
                <dt className="meta text-text-muted">Expires</dt>
                <dd className="mt-1 font-mono text-text-main">{fmtDateTime(createdCode.expiresAt)}</dd>
              </div>
            </dl>
          </div>
        )}
      </Modal>

      <Drawer
        isOpen={Boolean(redemptionsFor)}
        onClose={() => setRedemptionsFor(null)}
        title="Redemptions"
        width="lg"
      >
        <div className="flex flex-col gap-4">
          {redemptionsFor && (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-sm tracking-wider text-text-main">
                {redemptionsFor.displayCode || redemptionsFor.code}
              </span>
              <span className="text-xs text-text-muted">
                {grantLabel(redemptionsFor)} · {redemptionsFor.redeemedCount ?? 0} of{" "}
                {redemptionsFor.maxRedemptions ?? 1} used
              </span>
            </div>
          )}

          {redemptionsError && (
            <div className="border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {redemptionsError}
            </div>
          )}

          {redemptionsLoading ? (
            <CardSkeleton />
          ) : redemptions.length === 0 ? (
            <p className="text-sm text-text-muted">This code has not been redeemed yet.</p>
          ) : (
            <div className="border border-border">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="meta px-3 py-2 text-text-muted">User</th>
                    <th className="meta px-3 py-2 text-text-muted">Redeemed</th>
                    <th className="meta px-3 py-2 text-text-muted">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {redemptions.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2 font-mono text-xs text-text-main break-all">
                        {r.userEmail || r.userId}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
                        {fmtDateTime(r.redeemedAt)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
                        {fmtDate(r.planExpiresAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Drawer>

      <ConfirmModal
        isOpen={Boolean(confirmState)}
        onClose={() => setConfirmState(null)}
        onConfirm={disableCode}
        title="Disable gift code"
        message="The code stops working immediately. Redemptions already granted are untouched."
        confirmText="Disable"
        loading={Boolean(confirmState?.gift && rowBusyId === confirmState.gift.id)}
      />
    </div>
  );
}

function NewGiftCodeModal({ plans, onClose, onCreated }) {
  const activePlans = useMemo(() => plans.filter((p) => p.isActive), [plans]);
  // Mounted only while open, so these initialisers are the reset.
  const [grantType, setGrantType] = useState(activePlans.length ? "plan" : "credit");
  const [planId, setPlanId] = useState(activePlans[0]?.id || "");
  const [creditUsd, setCreditUsd] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [maxRedemptions, setMaxRedemptions] = useState("1");
  const [perUserLimit, setPerUserLimit] = useState("1");
  const [expiresOn, setExpiresOn] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");

    const max = Number(maxRedemptions);
    if (!Number.isInteger(max) || max < 1) {
      setError("Total redemptions must be at least 1.");
      return;
    }
    const perUser = Number(perUserLimit);
    if (!Number.isInteger(perUser) || perUser < 1) {
      setError("Per-user limit must be at least 1.");
      return;
    }
    if (perUser > max) {
      setError("Per-user limit cannot exceed total redemptions.");
      return;
    }

    const body = {
      maxRedemptions: max,
      perUserLimit: perUser,
      expiresAt: dateInputToExpiryIso(expiresOn),
      note: note.trim() || null,
    };

    if (grantType === "plan") {
      if (!planId) {
        setError("Select a plan.");
        return;
      }
      body.planId = planId;
    } else {
      const usd = Number(creditUsd);
      if (!Number.isFinite(usd) || usd <= 0) {
        setError("Enter a credit amount above zero.");
        return;
      }
      const days = Number(durationDays);
      if (!Number.isInteger(days) || days < 1) {
        setError("Duration must be at least 1 day.");
        return;
      }
      body.creditNanoUsd = usdToNano(usd);
      body.durationDays = days;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/gift-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not create the code.");
        return;
      }
      await onCreated(data.code);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const planOptions = activePlans.map((p) => ({
    value: p.id,
    label: `${p.name} · ${fmtCreditNano(p.creditNanoUsd, p.unlimitedCredit)} · ${p.durationDays}d`,
  }));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="New gift code"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} loading={saving}>Create code</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Grant</span>
          <div className="inline-flex w-full border border-border">
            {[
              { value: "plan", label: "Plan" },
              { value: "credit", label: "Credit" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setGrantType(opt.value)}
                aria-pressed={grantType === opt.value}
                className={`h-9 flex-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-150 ${
                  grantType === opt.value
                    ? "bg-brand-500 text-white"
                    : "bg-transparent text-text-muted hover:text-text-main"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {grantType === "plan" ? (
          activePlans.length === 0 ? (
            <p className="border border-border bg-surface-2 px-3 py-2 text-sm text-text-muted">
              No active plans exist yet. Create a plan first, or grant credit instead.
            </p>
          ) : (
            <Select
              label="Plan"
              options={planOptions}
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              placeholder="Select a plan"
            />
          )
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Credit amount (USD)"
              type="number"
              min="0"
              step="0.01"
              value={creditUsd}
              onChange={(e) => setCreditUsd(e.target.value)}
              placeholder="5.00"
              hint={creditUsd && Number.isFinite(Number(creditUsd))
                ? fmtUsdNano(usdToNano(Number(creditUsd)))
                : undefined}
            />
            <Input
              label="Valid for (days)"
              type="number"
              min="1"
              step="1"
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Total redemptions"
            type="number"
            min="1"
            step="1"
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            hint="How many users may redeem this code in total."
          />
          <Input
            label="Per-user limit"
            type="number"
            min="1"
            step="1"
            value={perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            hint="Each account can redeem this code up to this many times."
          />
        </div>

        <Input
          label="Expires on (optional)"
          type="date"
          value={expiresOn}
          onChange={(e) => setExpiresOn(e.target.value)}
          hint="Leave empty for a code that does not expire."
        />

        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Launch promo, support credit, ..."
          maxLength={200}
        />

        {error && (
          <p className="flex items-center gap-1 text-[11px] text-red-600">
            <span className="material-symbols-outlined text-[14px]">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
