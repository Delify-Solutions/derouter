"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Select,
  Modal,
  ConfirmModal,
  CardSkeleton,
} from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { fmtUsdNano } from "@/shared/utils/money";

/**
 * `/dashboard/payments` — receiving accounts and the transactions they produced
 * (design D9, specs payment-provider-admin + payment-reconciliation).
 *
 * Two tabs because they answer two different questions: "where does money arrive"
 * and "what arrived". Everything here is square, hairline-bordered and monospaced
 * where it carries data, per `openspec/ui-dna.md`; status is never colour alone.
 */

const TABS = [
  { value: "providers", label: "Nguồn nhận tiền" },
  { value: "transactions", label: "Giao dịch" },
];

const KIND_LABEL = {
  sepay: "SePay",
  web2m: "web2m",
  acb: "ACB",
  binance: "Binance Pay",
};

const KIND_DESCRIPTION = {
  sepay: "Webhook đẩy tức thì, có thể bật thêm API token để dò lại giao dịch bị lỡ.",
  web2m: "Dò lịch sử giao dịch ngân hàng qua API web2m của bạn.",
  acb: "Đọc lịch sử tài khoản qua API app ACB (không chính thức).",
  binance: "Dò lịch sử Binance Pay, ký HMAC-SHA256.",
};

const ACB_WARNING =
  "Dùng API app ACB không chính thức — ACB có thể thay đổi hoặc khóa truy cập; nên dùng tài khoản riêng cho việc nhận tiền.";

const STATUS_LABEL = {
  matched: "Đã khớp",
  needs_review: "Cần kiểm tra",
  resolved: "Đã xử lý",
};

const STATUS_STYLE = {
  matched: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  needs_review: "border-warning/30 bg-warning/10 text-warning",
  resolved: "border-border bg-surface-2 text-text-muted",
};

const REASON_LABEL = {
  no_code: "Không tìm thấy mã trong nội dung",
  order_not_found: "Mã không thuộc đơn nào",
  wrong_provider: "Sai nguồn nhận tiền",
  order_not_pending: "Đơn đã thanh toán / đã hủy",
  order_expired: "Đơn đã hết hạn",
  amount_mismatch: "Sai số tiền",
  underpaid: "Chuyển thiếu",
  admin_assigned: "Admin gán tay",
};

function fmtDateTime(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatVnd(value) {
  const digits = String(Math.round(Number(value) || 0));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${out}đ`;
}

function formatUsdt(nano) {
  const n = Math.round(Number(nano) || 0);
  const whole = Math.floor(Math.abs(n) / 1e9);
  const frac = String(Math.abs(n) % 1e9).padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/** One transaction's amount in the currency it was actually paid in. */
function amountText(tx) {
  if (tx.currency === "VND") return formatVnd(tx.amount);
  if (tx.currency === "USDT") return `${formatUsdt(tx.amount)} USDT`;
  return fmtUsdNano(tx.amount);
}

/** The empty form for a kind: the fields differ enough to be worth resetting. */
function emptyDraft(kind = "sepay") {
  return {
    kind,
    name: "",
    isActive: true,
    sortOrder: "0",
    pollIntervalSeconds: kind === "acb" ? "30" : "30",
    config: {
      bankBin: "",
      bankName: "",
      accountNumber: "",
      accountName: "",
      apiBase: "",
      urlStyle: "token",
      payUid: "",
      qrImageUrl: "",
      clientId: "",
      appApiKey: "",
      deviceId: "",
      appVersion: "",
    },
    // Empty string means "keep the stored secret" on PATCH.
    secrets: {},
  };
}

function draftFromProvider(provider) {
  return {
    kind: provider.kind,
    name: provider.name ?? "",
    isActive: provider.isActive !== false,
    sortOrder: String(provider.sortOrder ?? 0),
    pollIntervalSeconds: String(provider.pollIntervalSeconds ?? 30),
    config: { ...emptyDraft(provider.kind).config, ...(provider.config ?? {}) },
    secrets: {},
  };
}

/** Which secret inputs each kind shows, in the order the admin fills them. */
const SECRET_FIELDS = {
  sepay: [
    { key: "webhookKey", label: "Webhook key", hint: "Tạo tự động khi thêm nguồn; dán vào SePay." },
    { key: "apiToken", label: "API token (tuỳ chọn)", hint: "Cần để dò lại giao dịch bị lỡ webhook." },
  ],
  web2m: [
    { key: "token", label: "web2m token" },
    { key: "password", label: "Mật khẩu ngân hàng (chỉ kiểu URL thứ hai)" },
  ],
  acb: [
    { key: "username", label: "Tên đăng nhập internet banking" },
    { key: "password", label: "Mật khẩu internet banking" },
    { key: "proxyUrl", label: "Proxy HTTP (tuỳ chọn)", hint: "http://user:pass@host:port" },
  ],
  binance: [
    { key: "apiKey", label: "Binance API key" },
    { key: "apiSecret", label: "Binance API secret" },
  ],
};

/** "đã lưu (…a1b2)" — the only thing the API ever returns about a secret. */
function secretState(provider, key) {
  const entry = provider?.secretsSet?.[key];
  if (!entry?.set) return null;
  return entry.last4 ? `đã lưu (…${entry.last4})` : "đã lưu";
}

export default function PaymentsPageClient() {
  const [tab, setTab] = useState("providers");
  const [providers, setProviders] = useState([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  // Returned exactly once, at creation or regeneration.
  const [freshKey, setFreshKey] = useState(null);
  // Payment settings (spec payment-provider-admin "Payment settings"). Loaded with
  // the page because every one of them changes how a NEW order is created.
  const [settings, setSettings] = useState({
    paymentCodePrefix: "DR",
    paymentOrderTtlMinutes: 30,
    allowManualOrders: true,
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [testState, setTestState] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const loadProviders = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/payments/providers", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được nguồn nhận tiền");
      setProviders(Array.isArray(body.providers) ? body.providers : []);
      setWebhookUrl(body.webhookUrl || "/api/payments/sepay/webhook");

      // Settings come from the same admin settings document the rest of the
      // dashboard edits; read-only here apart from the three payment fields.
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      if (settingsRes.ok) {
        const current = await settingsRes.json().catch(() => ({}));
        setSettings((previous) => ({
          paymentCodePrefix: typeof current.paymentCodePrefix === "string" && current.paymentCodePrefix
            ? current.paymentCodePrefix
            : previous.paymentCodePrefix,
          paymentOrderTtlMinutes: Number.isInteger(current.paymentOrderTtlMinutes)
            ? current.paymentOrderTtlMinutes
            : previous.paymentOrderTtlMinutes,
          allowManualOrders: typeof current.allowManualOrders === "boolean"
            ? current.allowManualOrders
            : previous.allowManualOrders,
        }));
      }
    } catch (error) {
      setLoadError(error.message || "Không tải được nguồn nhận tiền");
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  // ── Payment settings ─────────────────────────────────────────────────────

  /**
   * Mirror of the PATCH /api/settings rules, so the error appears under the field
   * instead of as a 400 after a round trip. The API still validates: this is a
   * convenience, not the enforcement point.
   */
  const settingsErrors = {
    paymentCodePrefix: /^[A-Z]{2,6}$/.test(String(settings.paymentCodePrefix || "").trim().toUpperCase())
      ? ""
      : "2–6 chữ cái in hoa",
    paymentOrderTtlMinutes:
      Number.isInteger(Number(settings.paymentOrderTtlMinutes))
      && Number(settings.paymentOrderTtlMinutes) >= 10
      && Number(settings.paymentOrderTtlMinutes) <= 1440
        ? ""
        : "Số nguyên từ 10 đến 1440",
  };

  const setSetting = (field, value) => {
    setSettingsDirty(true);
    setSettings((current) => ({ ...current, [field]: value }));
  };

  const saveSettings = async () => {
    setSettingsError("");
    if (settingsErrors.paymentCodePrefix || settingsErrors.paymentOrderTtlMinutes) {
      setSettingsError("Kiểm tra lại tiền tố và thời hạn đơn");
      return;
    }
    setSettingsSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentCodePrefix: String(settings.paymentCodePrefix).trim().toUpperCase(),
          paymentOrderTtlMinutes: Number(settings.paymentOrderTtlMinutes),
          allowManualOrders: settings.allowManualOrders === true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSettingsError(body.error || "Không lưu được cài đặt thanh toán");
        return;
      }
      setSettingsDirty(false);
      setNotice({ type: "success", message: "Đã lưu cài đặt thanh toán" });
    } catch (error) {
      setSettingsError(error.message || "Không lưu được cài đặt thanh toán");
    } finally {
      setSettingsSaving(false);
    }
  };

  // ── Provider form ────────────────────────────────────────────────────────

  const openCreate = () => {
    setDraft(emptyDraft("sepay"));
    setEditing(null);
    setFormError("");
    setFreshKey(null);
    setShowForm(true);
  };

  const openEdit = (provider) => {
    setDraft(draftFromProvider(provider));
    setEditing(provider);
    setFormError("");
    setFreshKey(null);
    setShowForm(true);
  };

  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const setConfig = (field, value) =>
    setDraft((current) => ({ ...current, config: { ...current.config, [field]: value } }));
  const setSecret = (key, value) =>
    setDraft((current) => ({ ...current, secrets: { ...current.secrets, [key]: value } }));

  const submitForm = async () => {
    setSaving(true);
    setFormError("");
    try {
      const body = {
        kind: draft.kind,
        name: draft.name.trim(),
        isActive: draft.isActive,
        sortOrder: Number(draft.sortOrder || 0),
        pollIntervalSeconds: Number(draft.pollIntervalSeconds || 30),
        config: draft.config,
        // Only non-empty fields are sent; an empty one means "keep what is stored".
        secrets: Object.fromEntries(
          Object.entries(draft.secrets).filter(([, value]) => String(value ?? "").trim() !== "")
        ),
      };
      const res = await fetch(
        editing ? `/api/payments/providers/${editing.id}` : "/api/payments/providers",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không lưu được nguồn nhận tiền");
        return;
      }
      await loadProviders();
      setShowForm(false);
      setFreshKey(data.webhookKey || null);
      setNotice({
        type: "success",
        message: editing ? "Đã lưu nguồn nhận tiền" : "Đã thêm nguồn nhận tiền",
      });
    } catch (error) {
      setFormError(error.message || "Không lưu được nguồn nhận tiền");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (provider) => {
    setBusyId(provider.id);
    try {
      const res = await fetch(`/api/payments/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !provider.isActive }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không đổi được trạng thái");
      await loadProviders();
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    } finally {
      setBusyId(null);
    }
  };

  const regenerateKey = (provider) => {
    setConfirmState({
      title: "Tạo webhook key mới",
      message:
        "Key cũ sẽ ngừng hoạt động ngay. Sau khi tạo, dán key mới vào SePay, nếu không webhook sẽ bị từ chối.",
      confirmText: "Tạo key mới",
      variant: "danger",
      onConfirm: async () => {
        setConfirmState(null);
        setBusyId(provider.id);
        try {
          const res = await fetch(`/api/payments/providers/${provider.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ regenerateWebhookKey: true }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Không tạo được key mới");
          await loadProviders();
          setFreshKey(data.webhookKey || null);
          setNotice({ type: "success", message: "Đã tạo webhook key mới — dán vào SePay" });
        } catch (error) {
          setNotice({ type: "error", message: error.message });
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const removeProvider = (provider) => {
    setConfirmState({
      title: "Xóa nguồn nhận tiền",
      message: `Xóa "${provider.name}"? Chỉ xóa được khi chưa có đơn hay giao dịch nào; nếu đã có, hãy tắt thay vì xóa.`,
      confirmText: "Xóa",
      variant: "danger",
      onConfirm: async () => {
        setConfirmState(null);
        setBusyId(provider.id);
        try {
          const res = await fetch(`/api/payments/providers/${provider.id}`, { method: "DELETE" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Không xóa được nguồn nhận tiền");
          await loadProviders();
          setNotice({ type: "success", message: "Đã xóa nguồn nhận tiền" });
        } catch (error) {
          setNotice({ type: "error", message: error.message });
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const runTest = async (provider) => {
    setTestState({ providerId: provider.id, loading: true, results: [], error: "" });
    try {
      const res = await fetch(`/api/payments/providers/${provider.id}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestState({
          providerId: provider.id,
          loading: false,
          results: [],
          error: data.error || "Không chạy thử được",
        });
        return;
      }
      setTestState({
        providerId: provider.id,
        loading: false,
        results: Array.isArray(data.results) ? data.results : [],
        error: "",
      });
    } catch (error) {
      setTestState({ providerId: provider.id, loading: false, results: [], error: error.message });
    }
  };

  // ── Transactions tab ────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-8 max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6 border-b border-border">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-subtle">Billing</span>
          <h1 className="text-2xl font-semibold text-text-main">Thanh toán</h1>
          <p className="max-w-2xl text-sm text-text-muted">
            Mỗi đơn có một mã riêng trong nội dung chuyển khoản. Tiền vào khớp mã và đúng số
            tiền thì gói tự kích hoạt; mọi trường hợp khác nằm ở tab Giao dịch để bạn xử lý.
          </p>
        </div>
        {tab === "providers" && <Button icon="add" onClick={openCreate}>Thêm nguồn</Button>}
      </header>

      {/* Square tab bar: the ui-dna forbids the rounded segmented control. */}
      <div role="tablist" aria-label="Thanh toán" className="flex items-stretch border-b border-border -mt-4">
        {TABS.map((entry) => {
          const active = tab === entry.value;
          return (
            <button
              key={entry.value}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(entry.value)}
              className={`h-10 -mb-px border-b-2 px-4 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                active
                  ? "border-brand-500 text-text-main"
                  : "border-transparent text-text-muted hover:text-text-main"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* Payment settings (spec payment-provider-admin "Payment settings").
          Square panel, mono labels, one row per setting — the same rhythm as the
          rest of the dashboard. */}
      <PaymentSettingsPanel
        settings={settings}
        errors={settingsErrors}
        error={settingsError}
        dirty={settingsDirty}
        saving={settingsSaving}
        onChange={setSetting}
        onSave={saveSettings}
      />

      {notice && (
        <div
          className={`flex items-start gap-2 border px-4 py-3 ${
            notice.type === "error" ? "border-danger/40 bg-danger/5" : "border-brand-500/30 bg-brand-500/5"
          }`}
          role="status"
        >
          <span
            className={`material-symbols-outlined text-[18px] ${
              notice.type === "error" ? "text-danger" : "text-brand-600 dark:text-brand-400"
            }`}
            aria-hidden="true"
          >
            {notice.type === "error" ? "error" : "check_circle"}
          </span>
          <p className={`flex-1 text-sm ${notice.type === "error" ? "text-danger" : "text-text-main"}`}>
            {notice.message}
          </p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-main"
          >
            Đóng
          </button>
        </div>
      )}

      {freshKey && (
        <FreshKeyBox
          key={freshKey}
          webhookKey={freshKey}
          onDismiss={() => setFreshKey(null)}
        />
      )}

      {tab === "providers" ? (
        <ProvidersTab
          loading={providersLoading}
          error={loadError}
          providers={providers}
          webhookUrl={webhookUrl}
          busyId={busyId}
          testState={testState}
          onRetry={loadProviders}
          onEdit={openEdit}
          onToggle={toggleActive}
          onRegenerate={regenerateKey}
          onDelete={removeProvider}
          onTest={runTest}
        />
      ) : (
        <TransactionsTab />
      )}

      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? "Sửa nguồn nhận tiền" : "Thêm nguồn nhận tiền"}
        size="full"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={saving}>Hủy</Button>
            <Button onClick={submitForm} loading={saving}>
              {editing ? "Lưu" : "Thêm nguồn"}
            </Button>
          </>
        }
      >
        <ProviderForm
          draft={draft}
          editing={editing}
          error={formError}
          onField={setField}
          onConfig={setConfig}
          onSecret={setSecret}
        />
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Xác nhận"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Xác nhận"}
        variant={confirmState?.variant}
      />
    </div>
  );
}


// ── Payment settings ──────────────────────────────────────────────────────

/**
 * The three settings the payment spec requires (spec payment-provider-admin
 * "Payment settings"). They live on this page because they only mean anything to
 * payments: the prefix shapes every future code, the TTL every order's window, and
 * `allowManualOrders` whether the fallback method is offered at all.
 *
 * The poller note is operational truth the page has to state: order expiry is a
 * poller tick, so an operator who disables the poller silently loses it.
 */
function PaymentSettingsPanel({ settings, errors, error, dirty, saving, onChange, onSave }) {
  return (
    <section className="flex flex-col gap-4 border border-border bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="meta text-text-subtle">Cài đặt thanh toán</span>
          <p className="max-w-2xl text-sm text-text-muted">
            Áp dụng cho đơn tạo mới. Đơn đã tạo giữ nguyên mã, số tiền và hạn của nó.
          </p>
        </div>
        <Button onClick={onSave} loading={saving} disabled={!dirty}>
          Lưu cài đặt
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="payment-code-prefix"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted"
          >
            Tiền tố mã thanh toán
          </label>
          <input
            id="payment-code-prefix"
            value={settings.paymentCodePrefix}
            onChange={(event) => onChange("paymentCodePrefix", event.target.value.toUpperCase())}
            maxLength={6}
            aria-invalid={!!(errors.paymentCodePrefix && dirty)}
            className={`w-full border bg-surface px-3 py-2 font-mono text-sm uppercase tracking-[0.08em] text-text-main transition-colors focus:outline-none ${
              errors.paymentCodePrefix && dirty ? "border-danger" : "border-border focus:border-brand-500"
            }`}
            placeholder="DR"
          />
          <p className={`text-[11px] ${errors.paymentCodePrefix && dirty ? "text-danger" : "text-text-muted"}`}>
            {errors.paymentCodePrefix && dirty
              ? errors.paymentCodePrefix
              : "2–6 chữ cái in hoa, đứng trước 8 ký tự của mã trong nội dung chuyển khoản."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="payment-order-ttl"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted"
          >
            Hạn thanh toán (phút)
          </label>
          <input
            id="payment-order-ttl"
            type="number"
            min={10}
            max={1440}
            step={1}
            inputMode="numeric"
            value={settings.paymentOrderTtlMinutes}
            onChange={(event) => onChange("paymentOrderTtlMinutes", event.target.value)}
            aria-invalid={!!(errors.paymentOrderTtlMinutes && dirty)}
            className={`w-full border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors focus:outline-none ${
              errors.paymentOrderTtlMinutes && dirty ? "border-danger" : "border-border focus:border-brand-500"
            }`}
          />
          <p className={`text-[11px] ${errors.paymentOrderTtlMinutes && dirty ? "text-danger" : "text-text-muted"}`}>
            {errors.paymentOrderTtlMinutes && dirty
              ? errors.paymentOrderTtlMinutes
              : "10–1440 phút. Hết hạn thì đơn chuyển sang trạng thái hết hạn và không tính vào hạn mức tháng."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
            Đơn thủ công
          </span>
          <label className="flex h-[38px] items-center gap-2 border border-border px-3">
            <input
              type="checkbox"
              checked={settings.allowManualOrders === true}
              onChange={(event) => onChange("allowManualOrders", event.target.checked)}
              className="size-4"
            />
            <span className="text-sm text-text-main">Cho phép mua thủ công</span>
          </label>
          <p className="text-[11px] text-text-muted">
            Tắt thì khách chỉ thấy VietQR / Binance; dùng khi cả hai nguồn đã sẵn sàng.
          </p>
        </div>
      </div>

      {/* NC-3: operational truth, not a caveat hidden in code. */}
      <p className="border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
        Hết hạn đơn và việc dò giao dịch đều chạy trong tiến trình nền. Nếu bạn đặt{" "}
        <code className="font-mono text-text-main">DISABLE_PAYMENT_POLLER</code>, đơn chưa thanh toán sẽ
        không tự chuyển sang &quot;hết hạn&quot; và không có giao dịch nào được dò — khi đó phải tự hủy đơn
        hoặc bật lại tiến trình.
      </p>

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-danger">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
    </section>
  );
}

// ── Shared: copyable value ─────────────────────────────────────────────────

function CopyRow({ label, value, mono = true }) {
  const { copied, copy } = useCopyToClipboard(1500);
  if (!value) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="meta text-text-subtle">{label}</span>
      <div className="flex items-stretch border border-border">
        <code
          className={`flex-1 min-w-0 px-3 py-2 text-[12px] break-all text-text-main ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={`Sao chép ${label}`}
          className="shrink-0 border-l border-border px-3 font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-main"
        >
          {copied ? "Đã chép" : "Chép"}
        </button>
      </div>
    </div>
  );
}

/** The webhook key is readable exactly once; this box is the only chance to copy it. */
function FreshKeyBox({ webhookKey, onDismiss }) {
  if (!webhookKey) return null;
  return (
    <section className="border border-warning/40 bg-warning/5 p-4" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="meta text-warning">Webhook key mới — chỉ hiện một lần</span>
          <p className="text-sm text-text-muted">
            Dán key này vào SePay (chọn xác thực &quot;API Key&quot;). Sau khi đóng, hệ thống
            chỉ còn hiện 4 ký tự cuối.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-main"
        >
          Đóng
        </button>
      </div>
      <div className="mt-3">
        <CopyRow label="Webhook key" value={webhookKey} />
      </div>
    </section>
  );
}

// ── Providers tab ─────────────────────────────────────────────────────────

function ProvidersTab({
  loading, error, providers, webhookUrl, busyId, testState,
  onRetry, onEdit, onToggle, onRegenerate, onDelete, onTest,
}) {
  if (loading) return <CardSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden="true">error</span>
          <p className="flex-1 text-sm text-danger">{error}</p>
          <Button size="sm" variant="ghost" onClick={onRetry}>Thử lại</Button>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 border border-border px-6 py-16 text-center">
          <span className="material-symbols-outlined text-[32px] text-text-subtle" aria-hidden="true">
            account_balance
          </span>
          <p className="font-medium text-text-main">Chưa có nguồn nhận tiền</p>
          <p className="max-w-md text-sm text-text-muted">
            Thêm một tài khoản nhận tiền để khách trả bằng VietQR hoặc Binance. Chưa thêm thì
            khách chỉ còn cách mua thủ công.
          </p>
          {webhookUrl && (
            <p className="font-mono text-[11px] text-text-subtle">
              Webhook SePay sẽ là: {webhookUrl}
            </p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {providers.map((provider) => (
            <li key={provider.id} className="border border-border bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 py-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                      {KIND_LABEL[provider.kind] || provider.kind}
                    </span>
                    {/* Status is a word, never only a tint. */}
                    <span
                      className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        provider.isActive
                          ? "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400"
                          : "border-border bg-surface-2 text-text-muted"
                      }`}
                    >
                      {provider.isActive ? "Đang hoạt động" : "Đang tắt"}
                    </span>
                    <span className="font-mono text-[10px] text-text-subtle">thứ tự {provider.sortOrder}</span>
                  </div>
                  <h2 className="truncate text-base font-semibold text-text-main">{provider.name}</h2>
                  <p className="text-xs text-text-muted">{KIND_DESCRIPTION[provider.kind]}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => onTest(provider)}>
                    Chạy thử
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onEdit(provider)}>Sửa</Button>
                  <Button size="sm" variant="ghost" onClick={() => onToggle(provider)} disabled={busyId === provider.id}>
                    {provider.isActive ? "Tắt" : "Bật"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(provider)} disabled={busyId === provider.id}>
                    Xóa
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-2">
                <div className="flex flex-col gap-3">
                  {provider.kind === "acb" && (
                    <p className="border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
                      {ACB_WARNING}
                    </p>
                  )}

                  {provider.kind === "binance" ? (
                    <>
                      <CopyRow label="Binance Pay UID" value={provider.config?.payUid} />
                      <CopyRow label="Tên tài khoản" value={provider.config?.accountName} mono={false} />
                      <CopyRow label="Ảnh QR" value={provider.config?.qrImageUrl} />
                    </>
                  ) : (
                    <>
                      <CopyRow label="Số tài khoản" value={provider.config?.accountNumber} />
                      <CopyRow label="Chủ tài khoản" value={provider.config?.accountName} mono={false} />
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Ngân hàng" value={provider.config?.bankName} />
                        <Field label="BIN VietQR" value={provider.config?.bankBin} />
                      </div>
                      {provider.kind === "web2m" && (
                        <Field label="API base" value={provider.config?.apiBase} />
                      )}
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Chu kỳ dò" value={`${provider.pollIntervalSeconds}s`} />
                    <Field label="Lần dò cuối" value={fmtDateTime(provider.lastPolledAt)} />
                  </div>
                  {provider.lastError && (
                    <p className="border border-danger/40 bg-danger/5 px-3 py-2 text-[12px] break-words text-danger">
                      Lỗi gần nhất: {provider.lastError}
                    </p>
                  )}
                  <ul className="flex flex-col gap-1">
                    {Object.entries(provider.secretsSet || {}).map(([key, state]) => (
                      <li key={key} className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">
                          {key}
                        </span>
                        <span className="font-mono text-[11px] text-text-muted">
                          {state?.set ? `đã lưu${state.last4 ? ` (…${state.last4})` : ""}` : "chưa đặt"}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {provider.kind === "sepay" && (
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                      <CopyRow label="Webhook URL" value={webhookUrl} />
                      <p className="text-[11px] text-text-muted">
                        Trong SePay chọn xác thực &quot;API Key&quot; và dán key của nguồn này.
                        Key chỉ hiện đầy đủ lúc tạo hoặc lúc tạo lại.
                      </p>
                      <div>
                        <Button size="sm" variant="ghost" onClick={() => onRegenerate(provider)}>
                          Tạo webhook key mới
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {testState?.providerId === provider.id && (
                <DryRunResults state={testState} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="meta text-text-subtle">{label}</span>
      <span className="font-mono text-[12px] break-all text-text-main">{value || "—"}</span>
    </div>
  );
}

/** "Chạy thử" output: what reconciliation WOULD do, without writing anything. */
function DryRunResults({ state }) {
  if (state.loading) {
    return (
      <div className="border-t border-border px-6 py-4">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Đang chạy thử…</span>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="border-t border-border px-6 py-4">
        <p className="text-sm text-danger">{state.error}</p>
        <p className="mt-1 text-[11px] text-text-muted">
          Chạy thử chỉ đọc, không ghi dữ liệu và không đổi đơn nào.
        </p>
      </div>
    );
  }

  if (!state.results.length) {
    return (
      <div className="border-t border-border px-6 py-4">
        <p className="text-sm text-text-muted">
          Không có giao dịch nào trong khoảng gần đây — chưa có gì để khớp.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-2 px-6 py-3">
        <span className="meta text-text-subtle">Kết quả chạy thử</span>
        <span className="font-mono text-[10px] text-text-subtle">không ghi gì vào DB</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-y border-border bg-surface-2">
              {["Thời gian", "Số tiền", "Nội dung", "Kết quả", "Đơn"].map((header) => (
                <th key={header} className="meta px-4 py-2 text-left font-medium text-text-subtle whitespace-nowrap">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.results.map((row) => (
              <tr key={row.externalId} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2 font-mono text-[11px] text-text-muted whitespace-nowrap">
                  {fmtDateTime(row.occurredAt)}
                </td>
                <td className="px-4 py-2 font-mono text-[12px] text-text-main whitespace-nowrap">
                  {row.amountText}
                </td>
                <td className="max-w-[280px] truncate px-4 py-2 text-[12px] text-text-muted" title={row.content || ""}>
                  {row.content || "—"}
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <span
                    className={`inline-flex border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      row.outcome === "matched"
                        ? STATUS_STYLE.matched
                        : row.outcome === "duplicate"
                          ? STATUS_STYLE.resolved
                          : STATUS_STYLE.needs_review
                    }`}
                  >
                    {row.outcome === "matched"
                      ? "Sẽ khớp"
                      : row.outcome === "duplicate"
                        ? "Đã có"
                        : row.outcome === "ignored"
                          ? "Bỏ qua"
                          : REASON_LABEL[row.reason] || "Cần kiểm tra"}
                  </span>
                </td>
                <td className="px-4 py-2 text-[11px] text-text-muted">
                  {row.order ? `${row.order.planName || row.order.planCode} · ${row.order.email || ""}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Provider form ─────────────────────────────────────────────────────────

function ProviderForm({ draft, editing, error, onField, onConfig, onSecret }) {
  const kind = draft.kind;
  const secrets = SECRET_FIELDS[kind] || [];
  const isAcb = kind === "acb";

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Select
          label="Loại nguồn"
          value={kind}
          // Changing the kind on an existing provider would invalidate every stored
          // secret silently; a new provider is the honest way to switch.
          disabled={!!editing}
          onChange={(event) => onField("kind", event.target.value)}
          options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <Input
          label="Tên hiển thị"
          value={draft.name}
          onChange={(event) => onField("name", event.target.value)}
          placeholder="Vietcombank - nhận tiền"
          required
        />
        <Input
          label="Thứ tự"
          type="number"
          value={draft.sortOrder}
          onChange={(event) => onField("sortOrder", event.target.value)}
          hint="Số nhỏ được ưu tiên khi tạo đơn mới."
          inputMode="numeric"
        />
      </div>

      {isAcb && (
        <p className="border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
          {ACB_WARNING}
        </p>
      )}

      {kind !== "binance" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Số tài khoản"
            value={draft.config.accountNumber || ""}
            onChange={(event) => onConfig("accountNumber", event.target.value)}
            required
          />
          <Input
            label="Chủ tài khoản"
            value={draft.config.accountName || ""}
            onChange={(event) => onConfig("accountName", event.target.value)}
            hint="Không dấu, viết hoa — ngân hàng so khớp chính xác."
          />
          <Input
            label="Tên ngân hàng"
            value={draft.config.bankName || ""}
            onChange={(event) => onConfig("bankName", event.target.value)}
            placeholder="Vietcombank"
          />
          <Input
            label="BIN VietQR"
            value={draft.config.bankBin || ""}
            onChange={(event) => onConfig("bankBin", event.target.value)}
            placeholder="970436"
            hint="Mã BIN 6 số dùng để tạo ảnh QR."
            inputMode="numeric"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Binance Pay UID"
            value={draft.config.payUid || ""}
            onChange={(event) => onConfig("payUid", event.target.value)}
            required
          />
          <Input
            label="Tên tài khoản"
            value={draft.config.accountName || ""}
            onChange={(event) => onConfig("accountName", event.target.value)}
          />
          <Input
            label="Ảnh QR (URL)"
            value={draft.config.qrImageUrl || ""}
            onChange={(event) => onConfig("qrImageUrl", event.target.value)}
            placeholder="https://…"
            className="sm:col-span-2"
            hint="Ảnh QR Binance bạn tải từ app; khách quét để điền UID."
          />
        </div>
      )}

      {kind === "web2m" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="API base URL"
            value={draft.config.apiBase || ""}
            onChange={(event) => onConfig("apiBase", event.target.value)}
            placeholder="https://…"
            required
          />
          <Select
            label="Kiểu URL"
            value={draft.config.urlStyle || "token"}
            onChange={(event) => onConfig("urlStyle", event.target.value)}
            options={[
              { value: "token", label: "apiBase/token" },
              { value: "password_account_token", label: "apiBase/password/account/token" },
            ]}
          />
        </div>
      )}

      {isAcb && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="meta text-text-subtle">Định danh app (để trống dùng mặc định / biến môi trường)</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Client ID"
              value={draft.config.clientId || ""}
              onChange={(event) => onConfig("clientId", event.target.value)}
              placeholder="ACB_CLIENT_ID"
            />
            <Input
              label="App API key"
              value={draft.config.appApiKey || ""}
              onChange={(event) => onConfig("appApiKey", event.target.value)}
              placeholder="ACB_API_KEY"
            />
            <Input
              label="Device ID"
              value={draft.config.deviceId || ""}
              onChange={(event) => onConfig("deviceId", event.target.value)}
              placeholder="ACB_DEVICE_ID"
            />
            <Input
              label="App version"
              value={draft.config.appVersion || ""}
              onChange={(event) => onConfig("appVersion", event.target.value)}
              placeholder="ACB_APP_VERSION"
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <p className="meta text-text-subtle">Khóa bí mật</p>
        {kind === "sepay" && !editing && (
          <p className="text-[12px] text-text-muted">
            Webhook key được tạo tự động khi bạn bấm Thêm nguồn và hiện đúng một lần.
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {secrets.map((field) => {
            const stored = editing ? secretState(editing, field.key) : null;
            // SePay's webhook key is generated, never typed: showing an input would
            // invite an admin to set a weak one.
            if (kind === "sepay" && field.key === "webhookKey") {
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <span className="meta text-text-subtle">{field.label}</span>
                  <span className="border border-border px-3 py-2 font-mono text-[12px] text-text-muted">
                    {stored ?? "tạo tự động"}
                  </span>
                </div>
              );
            }
            return (
              <Input
                key={field.key}
                label={field.label}
                type="password"
                value={draft.secrets[field.key] ?? ""}
                onChange={(event) => onSecret(field.key, event.target.value)}
                placeholder={stored ? `${stored} — để trống nếu giữ nguyên` : ""}
                hint={field.hint}
                autoComplete="new-password"
              />
            );
          })}
        </div>
        <p className="text-[11px] text-text-muted">
          Khóa được mã hoá khi lưu và không bao giờ trả lại qua API — chỉ hiện 4 ký tự cuối.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Chu kỳ dò (giây)"
          type="number"
          value={draft.pollIntervalSeconds}
          onChange={(event) => onField("pollIntervalSeconds", event.target.value)}
          hint={isAcb ? "Tối thiểu 30 giây cho ACB." : "Tối thiểu 15 giây."}
          inputMode="numeric"
        />
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-text-main">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => onField("isActive", event.target.checked)}
            className="size-4"
          />
          Đang hoạt động (được dùng cho đơn mới)
        </label>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-danger">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
    </div>
  );
}

// ── Transactions tab ──────────────────────────────────────────────────────

function TransactionsTab() {
  const [status, setStatus] = useState("needs_review");
  const [providerId, setProviderId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ transactions: [], total: 0, needsReviewCount: 0, providers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingPayment, setPendingPayment] = useState(null);
  const [detail, setDetail] = useState(null);
  const [resolveState, setResolveState] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ page: String(page) });
      if (status) query.set("status", status);
      if (providerId) query.set("providerId", providerId);
      if (from) query.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) query.set("to", new Date(`${to}T23:59:59`).toISOString());
      const res = await fetch(`/api/payments/transactions?${query.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được giao dịch");
      setData({
        transactions: Array.isArray(body.transactions) ? body.transactions : [],
        total: body.total || 0,
        needsReviewCount: body.needsReviewCount || 0,
        providers: Array.isArray(body.providers) ? body.providers : [],
      });
    } catch (e) {
      setError(e.message || "Không tải được giao dịch");
    } finally {
      setLoading(false);
    }
  }, [status, providerId, from, to, page]);

  useEffect(() => { load(); }, [load]);

  const pages = Math.max(1, Math.ceil(data.total / 50));

  return (
    <div className="flex flex-col gap-4">
      {/* Filters. Explicit labels, so a screen reader announces which control
          narrows what. */}
      <div className="grid grid-cols-1 gap-3 border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Trạng thái"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          options={[
            { value: "", label: "Tất cả" },
            { value: "needs_review", label: `Cần kiểm tra (${data.needsReviewCount})` },
            { value: "matched", label: "Đã khớp" },
            { value: "resolved", label: "Đã xử lý" },
          ]}
        />
        <Select
          label="Nguồn"
          value={providerId}
          onChange={(event) => { setProviderId(event.target.value); setPage(1); }}
          options={[
            { value: "", label: "Tất cả" },
            ...data.providers.map((provider) => ({
              value: provider.id,
              label: `${provider.name} (${KIND_LABEL[provider.kind] || provider.kind})`,
            })),
          ]}
        />
        <Input
          label="Từ ngày"
          type="date"
          value={from}
          onChange={(event) => { setFrom(event.target.value); setPage(1); }}
        />
        <Input
          label="Đến ngày"
          type="date"
          value={to}
          onChange={(event) => { setTo(event.target.value); setPage(1); }}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden="true">error</span>
          <p className="flex-1 text-sm text-danger">{error}</p>
          <Button size="sm" variant="ghost" onClick={load}>Thử lại</Button>
        </div>
      )}

      {loading ? (
        <CardSkeleton />
      ) : data.transactions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border border-border px-6 py-16 text-center">
          <span className="material-symbols-outlined text-[32px] text-text-subtle" aria-hidden="true">
            receipt_long
          </span>
          <p className="font-medium text-text-main">Không có giao dịch nào khớp bộ lọc</p>
          <p className="max-w-md text-sm text-text-muted">
            Giao dịch xuất hiện ở đây ngay khi webhook hoặc lượt dò kế tiếp nhận được tiền.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Thời gian", "Nguồn", "Số tiền", "Nội dung", "Trạng thái", "Đơn / khách", ""].map((header) => (
                  <th key={header || "actions"} className="meta px-4 py-2.5 text-left font-medium text-text-subtle whitespace-nowrap">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-text-muted whitespace-nowrap">
                    {fmtDateTime(tx.occurredAt || tx.receivedAt)}
                    {tx.via && (
                      <span className="ml-1 text-text-subtle">({tx.via === "webhook" ? "webhook" : "dò"})</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-text-muted whitespace-nowrap">
                    {KIND_LABEL[tx.kind] || tx.kind}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">
                    {amountText(tx)}
                  </td>
                  <td className="max-w-[260px] px-4 py-2.5 text-[12px] text-text-muted">
                    <span className="block truncate" title={tx.content || ""}>{tx.content || "—"}</span>
                    {tx.status === "needs_review" && tx.reason && (
                      <span className="mt-0.5 block text-[11px] text-warning">
                        {REASON_LABEL[tx.reason] || tx.reason}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span
                      className={`inline-flex border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        STATUS_STYLE[tx.status] || STATUS_STYLE.resolved
                      }`}
                    >
                      {STATUS_LABEL[tx.status] || tx.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-text-muted">
                    {tx.order ? (
                      <>
                        <span className="block text-text-main">{tx.order.planName || tx.order.planCode}</span>
                        <span className="block">{tx.order.userEmail || "—"}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setDetail(tx)}
                        className="h-8 border border-border px-2 font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-main"
                      >
                        Xem
                      </button>
                      {tx.status === "needs_review" && (
                        <button
                          type="button"
                          onClick={() => setResolveState({ tx, action: "assign" })}
                          className="h-8 border border-brand-500 bg-brand-500 px-2 font-mono text-[10px] uppercase tracking-wider text-white transition-colors hover:bg-brand-600"
                        >
                          Gán vào đơn
                        </button>
                      )}
                      {tx.status === "needs_review" && (
                        <button
                          type="button"
                          onClick={() => setResolveState({ tx, action: "resolve" })}
                          className="h-8 border border-border px-2 font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-main"
                        >
                          Đã xử lý
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] text-text-muted">
            {data.total} giao dịch · trang {page}/{pages}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Trước
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
              Sau
            </Button>
          </div>
        </div>
      )}

      <Drawer
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title="Chi tiết giao dịch"
        width="lg"
      >
        {detail && (
          <div className="flex flex-col gap-4 p-6">
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Số tiền" value={amountText(detail)} />
              <Field label="Trạng thái" value={STATUS_LABEL[detail.status] || detail.status} />
              <Field label="Mã giao dịch ngoài" value={detail.externalId} />
              <Field label="Nhận lúc" value={fmtDateTime(detail.receivedAt)} />
              <Field label="Xảy ra lúc" value={fmtDateTime(detail.occurredAt)} />
              <Field label="Cách nhận" value={detail.via === "webhook" ? "webhook" : "dò"} />
              <Field label="Lý do" value={detail.reason ? REASON_LABEL[detail.reason] || detail.reason : "—"} />
              <Field label="Người xử lý" value={detail.resolvedBy || "—"} />
            </dl>
            {detail.content && <CopyRow label="Nội dung" value={detail.content} mono={false} />}
            {detail.resolutionNote && <CopyRow label="Ghi chú xử lý" value={detail.resolutionNote} mono={false} />}
            <div className="flex flex-col gap-1">
              <span className="meta text-text-subtle">Payload gốc</span>
              <pre className="max-h-80 overflow-auto border border-border bg-surface-2 p-3 font-mono text-[11px] text-text-main">
                {JSON.stringify(detail.raw ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>

      <ResolveModal
        // Remounting on a new target resets reason/order without an effect that
        // writes state on every open.
        key={resolveState ? `${resolveState.tx.id}:${resolveState.action}` : "closed"}
        state={resolveState}
        onClose={() => setResolveState(null)}
        onDone={async (message) => {
          setResolveState(null);
          await load();
          if (message) setPendingPayment(message);
        }}
      />

      {pendingPayment && (
        <div className="border border-brand-500/30 bg-brand-500/5 px-4 py-3" role="status">
          <p className="text-sm text-text-main">{pendingPayment}</p>
          <button
            type="button"
            onClick={() => setPendingPayment(null)}
            className="mt-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-main"
          >
            Đóng
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Resolve modal: "Gán vào đơn" needs an order, "Đánh dấu đã xử lý" does not, and
 * both need a reason of 3–500 characters — the same rule the API enforces, shown
 * before submitting rather than as a 400 afterwards.
 */
function ResolveModal({ state, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [orderId, setOrderId] = useState("");
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isAssign = state?.action === "assign";
  const reasonError = reason.trim().length < 3 || reason.trim().length > 500
    ? "Lý do phải có từ 3 đến 500 ký tự"
    : "";

  useEffect(() => {
    if (!state || !isAssign) return;
    // `assign` accepts a pending OR an expired order (a late payment is the very
    // case it exists for), so both lists are loaded. The order the transaction
    // already points at is fetched on its own: it may be older than one page and
    // is the right answer for `order_expired` / `order_not_pending` rows.
    let cancelled = false;
    const load = (url) => fetch(url, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    setOrdersLoading(true);
    Promise.all([
      load("/api/orders?status=pending"),
      load("/api/orders?status=expired"),
      state.tx.orderId ? load(`/api/orders/${encodeURIComponent(state.tx.orderId)}`) : null,
    ]).then(([pending, expired, linked]) => {
      if (cancelled) return;
      const byId = new Map();
      for (const body of [pending, expired]) {
        for (const order of Array.isArray(body?.orders) ? body.orders : []) byId.set(order.id, order);
      }
      const suggested = linked?.order;
      if (suggested && (suggested.status === "pending" || suggested.status === "expired")) {
        byId.set(suggested.id, suggested);
      }
      const list = Array.from(byId.values()).sort((a, b) => {
        if (a.id === state.tx.orderId) return -1;
        if (b.id === state.tx.orderId) return 1;
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      });
      setOrders(list);
      if (suggested && byId.has(suggested.id)) setOrderId(suggested.id);
    }).finally(() => {
      if (!cancelled) setOrdersLoading(false);
    });
    return () => { cancelled = true; };
  }, [state, isAssign]);

  const submit = async () => {
    if (reasonError) { setError(reasonError); return; }
    if (isAssign && !orderId) { setError("Chọn đơn để gán"); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/payments/transactions/${state.tx.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isAssign ? { action: "assign", orderId, reason } : { action: "resolve", reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không xử lý được giao dịch");
        return;
      }
      await onDone(
        isAssign
          ? "Đã gán giao dịch vào đơn và kích hoạt gói."
          : "Đã đánh dấu giao dịch là đã xử lý."
      );
    } catch (e) {
      setError(e.message || "Không xử lý được giao dịch");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={!!state}
      onClose={onClose}
      title={isAssign ? "Gán giao dịch vào đơn" : "Đánh dấu đã xử lý"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button onClick={submit} loading={saving}>
            {isAssign ? "Gán và kích hoạt" : "Đánh dấu đã xử lý"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {state && (
          <div className="flex flex-col gap-1 border border-border bg-surface-2 px-4 py-3">
            <span className="font-mono text-[14px] text-text-main">{amountText(state.tx)}</span>
            <span className="text-[12px] text-text-muted">{state.tx.content || "—"}</span>
            <span className="text-[11px] text-warning">
              {REASON_LABEL[state.tx.reason] || state.tx.reason}
            </span>
          </div>
        )}

        {isAssign && (
          <Select
            label="Đơn cần gán"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            disabled={ordersLoading}
            options={[
              { value: "", label: ordersLoading ? "Đang tải…" : "Chọn đơn đang chờ hoặc đã hết hạn" },
              ...orders.map((order) => ({
                value: order.id,
                label: `${order.status === "expired" ? "[hết hạn] " : ""}${order.planName || order.planCode || order.planId} · ${order.userEmail || "—"} · ${order.id.slice(0, 8)}`,
              })),
            ]}
            hint="Chỉ đơn đang chờ hoặc đã hết hạn mới gán được. Gán sẽ kích hoạt gói ngay."
          />
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="resolve-reason"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted"
          >
            Lý do *
          </label>
          <textarea
            id="resolve-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            aria-invalid={!!error}
            aria-describedby="resolve-reason-hint"
            placeholder={isAssign ? "Khách chuyển muộn 3 phút, đã kiểm tra sao kê" : "Đã hoàn tiền ngoài hệ thống"}
            className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main transition-colors focus:border-brand-500 focus:outline-none"
          />
          <p id="resolve-reason-hint" className={`text-[11px] ${reasonError && reason ? "text-danger" : "text-text-muted"}`}>
            {reasonError && reason ? reasonError : "Ghi vào nhật ký của khách."}
          </p>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
