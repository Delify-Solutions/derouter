"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  Button,
  Modal,
  ConfirmModal,
  Badge,
  CardSkeleton,
} from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import UserPicker from "./components/UserPicker";
import AssignResults from "./components/AssignResults";
import GiftCodeFormModal from "./components/GiftCodeFormModal";

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
    const name = gift.planName || gift.planId || "Plan";
    // A top-up plan gifted as an amount: "Start · 100.000đ → $40.00".
    if (gift.amountVnd != null) {
      const credit = gift.amountCreditNanoUsd ? ` → ${fmtUsdNano(gift.amountCreditNanoUsd)}` : "";
      return `${name} · ${formatVnd(gift.amountVnd)}${credit}`;
    }
    return name;
  }
  return fmtUsdNano(gift.creditNanoUsd ?? 0);
}

/** One RPM/TPM value of a code: empty follows the plan (none for credit), 0 = no limit. */
function giftRateText(gift, value) {
  if (value == null) return gift.grantKind === "plan" ? "theo gói" : "∞";
  return Number(value) > 0 ? Number(value).toLocaleString("vi-VN") : "∞";
}

function matchesFilter(gift, filter) {
  if (filter === "all") return true;
  const status = giftStatus(gift);
  if (filter === "active") return status === "active" || status === "scheduled";
  if (filter === "disabled") return status === "disabled" || status === "expired";
  if (filter === "exhausted") return status === "exhausted";
  return true;
}


/** The places a code is used, in words ("" when unused). */
function usagePlaces(usage) {
  if (!usage) return [];
  const places = [];
  if (usage.referralDefault) places.push("quà chào mừng mặc định của chương trình giới thiệu");
  if (Number(usage.affiliateCount) > 0) places.push(`quà riêng của ${usage.affiliateCount} CTV`);
  if (usage.popup) places.push("mã của popup khuyến mãi");
  return places;
}

/** Delete dialog warning: what deleting the code unlinks. */
function usageWarning(usage) {
  const places = usagePlaces(usage);
  if (places.length === 0) return "";
  const popupNote = usage.popup ? " Chữ trong popup giữ nguyên, hãy sửa lại nếu có nhắc tới mã." : "";
  return `Mã đang được dùng làm ${places.join(", ")}: xóa sẽ tự gỡ mã khỏi các chỗ này.${popupNote}`;
}

/** After a delete: what was unlinked, from the server's count. */
function unlinkedText(unlinked) {
  if (!unlinked) return "";
  return usagePlaces({
    referralDefault: unlinked.referralDefault,
    affiliateCount: unlinked.affiliates,
    popup: unlinked.popup,
  }).join(", ");
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
  const [notice, setNotice] = useState("");
  const [redemptionsFor, setRedemptionsFor] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [redemptionsError, setRedemptionsError] = useState("");
  const [rowBusyId, setRowBusyId] = useState(null);
  const [assignFor, setAssignFor] = useState(null);
  const [editFor, setEditFor] = useState(null);

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

  const deleteCode = async () => {
    const gift = confirmState?.gift;
    if (!gift) return;
    setRowBusyId(gift.id);
    setLoadError("");
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Không xóa được mã.");
        return;
      }
      // Hard or soft, the code leaves the list: a soft-deleted one only keeps its
      // redemption history for the accounts that used it.
      setCodes((prev) => prev.filter((g) => g.id !== gift.id));
      setConfirmState(null);
      const removed = unlinkedText(data.unlinked);
      setNotice(`Đã xóa mã ${gift.displayCode || gift.code}.${removed ? ` Đã gỡ khỏi ${removed}.` : ""}`);
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
            Codes grant a plan or a credit balance when a user redeems one. Every field can be edited later; changes apply
            to later redemptions only. Deleting a used code keeps its redemption history.
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

      {notice && (
        <p role="status" className="flex items-start gap-2 border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">
          <span className="flex-1">{notice}</span>
          <button type="button" className="text-xs underline" onClick={() => setNotice("")}>Đóng</button>
        </p>
      )}

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
                        <span className="whitespace-nowrap font-mono text-sm tracking-wider text-text-main">
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
                      {gift.newUserOnly && (
                        <span className="mt-1 inline-flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
                          <span className="material-symbols-outlined text-[13px]" aria-hidden="true">person_add</span>
                          Người mới
                        </span>
                      )}
                      {gift.note && <p className="mt-1 text-xs text-text-subtle">{gift.note}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-text-main">{grantLabel(gift)}</span>
                      {gift.grantKind === "credit" && gift.durationDays ? (
                        <p className="text-xs text-text-subtle">{gift.durationDays} days</p>
                      ) : null}
                      {(gift.rpm != null || gift.tpm != null) && (
                        <p className="font-mono text-[11px] text-text-subtle whitespace-nowrap">
                          RPM {giftRateText(gift, gift.rpm)} · TPM {giftRateText(gift, gift.tpm)}
                        </p>
                      )}
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
                          icon="edit"
                          disabled={busy}
                          onClick={() => setEditFor(gift)}
                        >
                          Sửa
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="person_add"
                          disabled={!gift.isActive || status === "exhausted" || status === "expired"}
                          onClick={() => setAssignFor(gift)}
                        >
                          Gắn cho user
                        </Button>
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
                          icon="delete"
                          className="text-danger hover:bg-red-500/10"
                          disabled={busy}
                          onClick={() => setConfirmState({ gift })}
                        >
                          Xóa
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

      {editFor && (
        <GiftCodeFormModal
          plans={plans}
          gift={editFor}
          onClose={() => setEditFor(null)}
          onSaved={(code) => {
            setEditFor(null);
            if (code) setCodes((prev) => prev.map((g) => (g.id === code.id ? code : g)));
          }}
        />
      )}

      {assignFor && (
        <AssignGiftModal
          gift={assignFor}
          onClose={() => setAssignFor(null)}
          onAssigned={(code) => {
            if (code) setCodes((prev) => prev.map((g) => (g.id === code.id ? code : g)));
          }}
        />
      )}

      {createOpen && (
        <GiftCodeFormModal
          plans={plans}
          onClose={() => setCreateOpen(false)}
          onSaved={async (code, assigned) => {
            setCreateOpen(false);
            setCreatedCode({ ...code, assigned: assigned ?? null });
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
              {createdCode.assigned
                ? "Mã đã được gắn thẳng cho các tài khoản bên dưới; họ không cần nhập mã. Lượt còn lại vẫn dùng được bằng cách nhập mã."
                : "Share this code with whoever should redeem it. It stays visible in the list below."}
            </p>
            {createdCode.assigned && <AssignResults results={createdCode.assigned} />}
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
                    <th className="meta px-3 py-2 text-text-muted">Cách nhận</th>
                    <th className="meta px-3 py-2 text-text-muted">Telegram</th>
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
                      <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">
                        {r.assignedBy ? "Admin gắn" : "Tự nhập mã"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
                        {r.telegramUserId
                          ? `${r.telegramUsername ? `@${r.telegramUsername} · ` : ""}${r.telegramUserId}`
                          : "—"}
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
        onConfirm={deleteCode}
        title={`Xóa mã ${confirmState?.gift?.displayCode || confirmState?.gift?.code || ""}`}
        message={[
          Number(confirmState?.gift?.redeemedCount) > 0
            ? `Mã đã được dùng ${confirmState.gift.redeemedCount} lượt: mã sẽ biến mất khỏi danh sách và không nhập được nữa. Gói/credit đã cấp và lịch sử các lượt dùng giữ nguyên. Có thể tạo mã mới trùng chuỗi này.`
            : "Mã chưa ai dùng sẽ bị xóa hẳn. Không thể hoàn tác.",
          usageWarning(confirmState?.gift?.usage),
        ].filter(Boolean).join(" ")}
        confirmText="Xóa"
        loading={Boolean(confirmState?.gift && rowBusyId === confirmState.gift.id)}
      />
    </div>
  );
}

/** Give an existing code to accounts without them typing it. */
function AssignGiftModal({ gift, onClose, onAssigned }) {
  const [assignees, setAssignees] = useState([]);
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const left = Math.max(0, (gift.maxRedemptions ?? 1) - (gift.redeemedCount ?? 0));

  const submit = async () => {
    setError("");
    if (assignees.length === 0) {
      setError("Chọn ít nhất một tài khoản.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: assignees.map((user) => user.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không gắn được mã.");
        return;
      }
      setResults(data.results || []);
      setAssignees([]);
      onAssigned(data.code);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Gắn mã cho tài khoản"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{results ? "Đóng" : "Hủy"}</Button>
          <Button onClick={submit} loading={saving} disabled={assignees.length === 0}>Gắn mã</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-sm tracking-wider text-text-main">{gift.displayCode || gift.code}</span>
          <span className="text-xs text-text-muted">
            {grantLabel(gift)} · còn {left} lượt · mỗi tài khoản tối đa {gift.perUserLimit ?? 1} lần
          </span>
        </div>
        <UserPicker
          id="gift-assign-picker"
          value={assignees}
          onChange={setAssignees}
          hint="Tài khoản nhận quà ngay, không cần nhập mã. Mỗi tài khoản dùng 1 lượt của mã."
        />
        {assignees.length > left && (
          <p className="text-xs text-danger" role="alert">
            Mã chỉ còn {left} lượt; {assignees.length - left} tài khoản cuối sẽ không nhận được.
          </p>
        )}
        {results && <AssignResults results={results} />}
        {error && (
          <p className="flex items-center gap-1 text-[11px] text-red-600" role="alert">
            <span className="material-symbols-outlined text-[14px]">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
