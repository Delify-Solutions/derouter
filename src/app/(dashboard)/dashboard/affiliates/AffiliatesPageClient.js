"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Select, Badge, CardSkeleton, Toggle } from "@/shared/components";
import { fmtUsdNano, NANO } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import { parseCountInput, parseSignedAmountInput, parseUsdInput, parseVndInput } from "@/lib/affiliate/amountInput.js";

// `openspec/ui-dna.md`: square, hairline, mono where it matters, no colour-only
// status. All copy is Vietnamese; the rate is entered in percent and stored in bp.
const TABS = [
  { value: "settings", label: "Cài đặt" },
  { value: "affiliates", label: "CTV" },
  { value: "referrals", label: "Người được giới thiệu" },
  { value: "commissions", label: "Hoa hồng" },
  { value: "vouchers", label: "Voucher" },
];

const PAGE_SIZE = 25;

const COMMISSION_STATUS = {
  pending: { label: "Đang giữ", tone: "warning" },
  available: { label: "Khả dụng", tone: "success" },
  reversed: { label: "Đã hủy", tone: "danger" },
};

// `Badge` calls its red "error"; the tone names here stay semantic.
const BADGE_TONE = { success: "success", warning: "warning", danger: "error", neutral: "default" };

// Gift-code states as the admin reads them (the API reports giftStatusOf values).
const GIFT_STATUS_LABEL = {
  disabled: "đang tắt",
  scheduled: "chưa đến ngày",
  expired: "hết hạn",
  exhausted: "hết lượt",
  missing: "không tồn tại",
};

function giftOptionLabel(code) {
  if (code.status === "active") return code.code;
  return `${code.code} (${GIFT_STATUS_LABEL[code.status] || code.status})`;
}

/** nano-USD → "12.5" for an input field, exact (no float division). */
function nanoToUsdText(nano) {
  const n = Math.max(0, Math.trunc(Number(nano) || 0));
  const whole = Math.floor(n / NANO);
  const frac = String(n % NANO).padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function money(currency, value) {
  return currency === "VND" ? formatVnd(value) : fmtUsdNano(value);
}

/** `1000` bp → `10`, `1250` → `12.5`. The inverse of the save path. */
function bpToPercentText(bp) {
  if (bp == null || bp === "") return "";
  const percent = Number(bp) / 100;
  return Number.isInteger(percent) ? String(percent) : String(percent);
}

/**
 * Percent (text, up to 2 decimals) → integer bp. Integer math on the decimal
 * string, so `12.35` cannot become `1234` through a float round-trip.
 */
function percentTextToBp(text) {
  const raw = String(text ?? "").trim().replace(",", ".");
  if (!raw) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return NaN;
  const [whole, frac = ""] = raw.split(".");
  const bp = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(bp) ? bp : NaN;
}

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN");
}

export default function AffiliatesPageClient({ initialTab = "", initialQuery = "" }) {
  const [tab, setTab] = useState(TABS.some((entry) => entry.value === initialTab) ? initialTab : "settings");
  const [notice, setNotice] = useState(null);
  // "Xem người được giới thiệu" on a CTV row opens the referrals tab filtered to it.
  const [referralAffiliate, setReferralAffiliate] = useState(null);

  return (
    <div className="flex flex-col gap-8 max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-subtle">Growth</span>
          <h1 className="text-2xl font-semibold text-text-main">Affiliate</h1>
          <p className="max-w-2xl text-sm text-text-muted">
            Chương trình giới thiệu: mỗi tài khoản có một đường dẫn riêng, hoa hồng tính trên
            các đơn đã thanh toán của người được giới thiệu, được giữ một thời gian rồi mới dùng được (đổi credit hoặc tạo voucher).
          </p>
        </div>
      </header>

      {notice && (
        <p
          role="status"
          className={`border px-4 py-2 text-sm ${
            notice.tone === "error"
              ? "border-danger/40 bg-danger/5 text-danger"
              : "border-brand-500/40 bg-brand-500/5 text-brand-700 dark:text-brand-400"
          }`}
        >
          {notice.text}
        </p>
      )}

      <div role="tablist" aria-label="Affiliate" className="flex items-stretch border-b border-border -mt-4">
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
                active ? "border-brand-500 text-text-main" : "border-transparent text-text-muted hover:text-text-main"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "settings" && <SettingsTab onNotice={setNotice} />}
      {tab === "affiliates" && (
        <AffiliatesTab
          initialQuery={initialQuery}
          onNotice={setNotice}
          onShowReferrals={(row) => {
            setReferralAffiliate({ userId: row.userId, email: row.email });
            setTab("referrals");
          }}
        />
      )}
      {tab === "referrals" && (
        <ReferralsTab
          affiliate={referralAffiliate}
          onClearAffiliate={() => setReferralAffiliate(null)}
          onNotice={setNotice}
        />
      )}
      {tab === "commissions" && <CommissionsTab onNotice={setNotice} />}
      {tab === "vouchers" && <VouchersTab />}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────

function SettingsTab({ onNotice }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState([]);
  const [plans, setPlans] = useState([]);
  const [form, setForm] = useState({
    affiliateEnabled: false,
    affiliateDefaultRatePercent: "",
    affiliateDefaultMaxOrders: "",
    affiliateHoldDays: "",
    affiliateCookieDays: "",
    affiliateMinRedeemVnd: "",
    affiliateMinRedeemUsd: "",
    affiliateDefaultGiftCodeId: "",
    affiliateVndPerUsd: "",
    affiliateCreditPlanId: "",
    affiliateCreditDays: "",
    affiliateBuyerBonusPercent: "",
    affiliateBuyerBonusMaxOrders: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [settingsRes, codesRes, plansRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/affiliates/gift-codes", { cache: "no-store" }),
        fetch("/api/plans", { cache: "no-store" }),
      ]);
      const settings = await settingsRes.json().catch(() => ({}));
      const codeBody = await codesRes.json().catch(() => ({}));
      const planBody = await plansRes.json().catch(() => ({}));
      if (!settingsRes.ok) throw new Error(settings.error || "Không tải được cài đặt");
      setCodes(Array.isArray(codeBody.codes) ? codeBody.codes : []);
      setPlans(Array.isArray(planBody.plans) ? planBody.plans : []);
      setForm({
        affiliateEnabled: settings.affiliateEnabled === true,
        affiliateDefaultRatePercent: bpToPercentText(settings.affiliateDefaultRateBp),
        affiliateDefaultMaxOrders: String(settings.affiliateDefaultMaxOrders ?? ""),
        affiliateHoldDays: String(settings.affiliateHoldDays ?? ""),
        affiliateCookieDays: String(settings.affiliateCookieDays ?? ""),
        affiliateMinRedeemVnd: String(settings.affiliateMinRedeemVnd ?? ""),
        // nano-USD → USD text for the field; the save path converts back exactly.
        affiliateMinRedeemUsd: nanoToUsdText(settings.affiliateMinRedeemUsdNano ?? 0),
        affiliateDefaultGiftCodeId: settings.affiliateDefaultGiftCodeId || "",
        affiliateVndPerUsd: String(settings.affiliateVndPerUsd ?? ""),
        affiliateCreditPlanId: settings.affiliateCreditPlanId || "",
        affiliateCreditDays: String(settings.affiliateCreditDays ?? ""),
        affiliateBuyerBonusPercent: bpToPercentText(settings.affiliateBuyerBonusBp ?? 0),
        affiliateBuyerBonusMaxOrders: String(settings.affiliateBuyerBonusMaxOrders ?? ""),
      });
    } catch (e) {
      setError(e.message || "Không tải được cài đặt");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const rateBp = percentTextToBp(form.affiliateDefaultRatePercent);
      if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
        setError("Tỷ lệ hoa hồng phải từ 0 đến 100%, tối đa 2 chữ số thập phân.");
        return;
      }
      // Every number is parsed on its own terms: a blank or "100.000" must be an
      // error here, never a silent 0 or 100 (Number("") is 0, Number("100.000") 100).
      const maxOrders = parseCountInput(form.affiliateDefaultMaxOrders);
      const holdDays = parseCountInput(form.affiliateHoldDays);
      const cookieDays = parseCountInput(form.affiliateCookieDays);
      const minVnd = parseVndInput(form.affiliateMinRedeemVnd);
      const usdNano = parseUsdInput(form.affiliateMinRedeemUsd);
      const vndPerUsd = parseVndInput(form.affiliateVndPerUsd);
      const creditDays = parseCountInput(form.affiliateCreditDays);
      const buyerBonusBp = percentTextToBp(form.affiliateBuyerBonusPercent || "0");
      const buyerMaxOrders = parseCountInput(form.affiliateBuyerBonusMaxOrders);
      const problems = [
        [vndPerUsd === null || vndPerUsd < 1, "Tỷ giá phải là số đồng cho 1 USD, ví dụ 25000 hoặc 25.000."],
        [creditDays === null || creditDays < 1 || creditDays > 365, "Hạn credit phải là số ngày từ 1 đến 365."],
        [!Number.isInteger(buyerBonusBp) || buyerBonusBp < 0 || buyerBonusBp > 10000, "Quà người được giới thiệu phải từ 0 đến 100%."],
        [buyerMaxOrders === null || buyerMaxOrders > 1000, "Số đơn được quà phải là số nguyên từ 0 đến 1000."],
        [maxOrders === null || maxOrders > 1000, "Số đơn mặc định phải là số nguyên từ 0 đến 1000."],
        [holdDays === null || holdDays > 365, "Số ngày giữ hoa hồng phải là số nguyên từ 0 đến 365."],
        [cookieDays === null || cookieDays < 1 || cookieDays > 365, "Số ngày giữ cookie phải là số nguyên từ 1 đến 365."],
        [minVnd === null, "Tối thiểu mỗi lần (đồng) phải là số đồng, ví dụ 10000 hoặc 10.000."],
        [usdNano === null, "Tối thiểu mỗi lần (USD) phải là số USD, ví dụ 1 hoặc 1.50."],
      ];
      const problem = problems.find(([bad]) => bad);
      if (problem) {
        setError(problem[1]);
        return;
      }

      const payload = {
        affiliateEnabled: form.affiliateEnabled,
        affiliateDefaultRateBp: rateBp,
        affiliateDefaultMaxOrders: maxOrders,
        affiliateHoldDays: holdDays,
        affiliateCookieDays: cookieDays,
        affiliateMinRedeemVnd: minVnd,
        affiliateMinRedeemUsdNano: usdNano,
        affiliateDefaultGiftCodeId: form.affiliateDefaultGiftCodeId || "",
        affiliateVndPerUsd: vndPerUsd,
        affiliateCreditPlanId: form.affiliateCreditPlanId || "",
        affiliateCreditDays: creditDays,
        affiliateBuyerBonusBp: buyerBonusBp,
        affiliateBuyerBonusMaxOrders: buyerMaxOrders,
      };

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không lưu được cài đặt");
        onNotice({ tone: "error", text: body.error || "Không lưu được cài đặt" });
        return;
      }
      onNotice({ tone: "ok", text: "Đã lưu cài đặt chương trình giới thiệu." });
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <CardSkeleton />;

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <div className="flex flex-col gap-5 border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text-main">Bật chương trình</p>
            <p className="text-xs text-text-muted">
              Tắt thì đường dẫn không ghi nhận người mới và không phát sinh hoa hồng. Số dư cũ giữ nguyên.
            </p>
          </div>
          <Toggle
            aria-label="Bật chương trình giới thiệu"
            checked={form.affiliateEnabled}
            onChange={(value) => setForm((f) => ({ ...f, affiliateEnabled: value }))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Tỷ lệ hoa hồng mặc định (%)"
            value={form.affiliateDefaultRatePercent}
            onChange={(e) => setForm((f) => ({ ...f, affiliateDefaultRatePercent: e.target.value }))}
            hint="0–100, tối đa 2 chữ số thập phân"
            inputMode="decimal"
          />
          <Input
            label="Số đơn mặc định (N)"
            value={form.affiliateDefaultMaxOrders}
            onChange={(e) => setForm((f) => ({ ...f, affiliateDefaultMaxOrders: e.target.value }))}
            hint="0 = mọi đơn đã thanh toán"
            inputMode="numeric"
          />
          <Input
            label="Số ngày giữ hoa hồng"
            value={form.affiliateHoldDays}
            onChange={(e) => setForm((f) => ({ ...f, affiliateHoldDays: e.target.value }))}
            hint="0–365"
            inputMode="numeric"
          />
          <Input
            label="Số ngày giữ cookie giới thiệu"
            value={form.affiliateCookieDays}
            onChange={(e) => setForm((f) => ({ ...f, affiliateCookieDays: e.target.value }))}
            hint="1–365"
            inputMode="numeric"
          />
          <Input
            label="Tối thiểu mỗi lần dùng (đồng)"
            value={form.affiliateMinRedeemVnd}
            onChange={(e) => setForm((f) => ({ ...f, affiliateMinRedeemVnd: e.target.value }))}
            hint="Mỗi lần đổi credit hoặc tạo voucher"
            inputMode="numeric"
          />
          <Input
            label="Tối thiểu mỗi lần dùng (USD)"
            value={form.affiliateMinRedeemUsd}
            onChange={(e) => setForm((f) => ({ ...f, affiliateMinRedeemUsd: e.target.value }))}
            inputMode="decimal"
          />
          <Input
            label="Tỷ giá (đồng cho $1 credit)"
            value={form.affiliateVndPerUsd}
            onChange={(e) => setForm((f) => ({ ...f, affiliateVndPerUsd: e.target.value }))}
            hint="Đổi hoa hồng VND ra credit và quy đổi voucher khác đơn vị"
            inputMode="numeric"
          />
          <Input
            label="Hạn credit đổi / quà (ngày)"
            value={form.affiliateCreditDays}
            onChange={(e) => setForm((f) => ({ ...f, affiliateCreditDays: e.target.value }))}
            hint="Mỗi lần đổi là một khoản riêng với hạn riêng"
            inputMode="numeric"
          />
          <Input
            label="Quà người được giới thiệu (%)"
            value={form.affiliateBuyerBonusPercent}
            onChange={(e) => setForm((f) => ({ ...f, affiliateBuyerBonusPercent: e.target.value }))}
            hint="% credit thêm mỗi đơn; gói không giới hạn: % giảm giá. 0 = tắt"
            inputMode="decimal"
          />
          <Input
            label="Số đơn được quà (N)"
            value={form.affiliateBuyerBonusMaxOrders}
            onChange={(e) => setForm((f) => ({ ...f, affiliateBuyerBonusMaxOrders: e.target.value }))}
            hint="0 = mọi đơn đã thanh toán"
            inputMode="numeric"
          />
        </div>

        <Select
          label="Gói khuôn cho credit (RPM, TPM, hạn mức)"
          value={form.affiliateCreditPlanId}
          onChange={(e) => setForm((f) => ({ ...f, affiliateCreditPlanId: e.target.value }))}
          options={[
            { value: "", label: "Chưa chọn — tắt đổi credit và quà credit" },
            ...plans.map((plan) => ({
              value: plan.id,
              label: `${plan.name || plan.code}${plan.rpm ? ` · ${plan.rpm} RPM` : ""}${plan.tpm ? ` · ${plan.tpm} TPM` : ""}${plan.isActive ? "" : " (ẩn)"}`,
            })),
          ]}
        />

        <Select
          label="Mã quà tặng chào mừng mặc định"
          value={form.affiliateDefaultGiftCodeId}
          onChange={(e) => setForm((f) => ({ ...f, affiliateDefaultGiftCodeId: e.target.value }))}
          options={[
            { value: "", label: "Không có" },
            ...codes.map((code) => ({
              value: code.id,
              label: giftOptionLabel(code),
            })),
          ]}
        />

        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}

        <div>
          <Button onClick={save} loading={saving}>Lưu cài đặt</Button>
        </div>
      </div>

      <aside className="flex flex-col gap-3 border border-border bg-surface p-6">
        <p className="meta text-text-muted">Cách tính</p>
        <p className="text-sm leading-6 text-text-muted">
          Hoa hồng = số tiền khách thực trả × tỷ lệ, làm tròn xuống, giữ nguyên đơn vị tiền khách trả.
          VND là đồng, USDT và USD là nano-USD, không quy đổi.
        </p>
        <p className="text-sm leading-6 text-text-muted">
          “Số đơn” đếm các đơn đã thanh toán của từng người được giới thiệu: N = 1 nghĩa là chỉ đơn
          đầu tiên của mỗi người phát sinh hoa hồng. Đơn thanh toán lúc chương trình tắt hoặc CTV
          đang bị khóa vẫn tính là đã dùng suất. Một đơn bị hoàn tiền trả lại suất cho đơn kế tiếp.
        </p>
        <p className="text-sm leading-6 text-text-muted">
          Chỉ chọn được mã người mới (bắt buộc liên kết Telegram) làm quà giới thiệu.
        </p>
        <p className="text-sm leading-6 text-text-muted">
          Hoa hồng không rút ra tiền mặt. CTV đổi thành credit (theo tỷ giá, giới hạn tốc độ của gói khuôn,
          mỗi lần một khoản có hạn riêng) hoặc tạo voucher dùng một lần để trừ vào giá gói khi thanh toán.
        </p>
      </aside>
    </section>
  );
}

// ── Affiliates ────────────────────────────────────────────────────────────

function AffiliatesTab({ onNotice, onShowReferrals, initialQuery = "" }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState(initialQuery);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const res = await fetch(`/api/affiliates?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được danh sách CTV");
      setRows(Array.isArray(body.affiliates) ? body.affiliates : []);
      setTotal(Number(body.total) || 0);
    } catch (e) {
      setError(e.message || "Không tải được danh sách CTV");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, q, status]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Tìm" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="email, tên hoặc mã" />
        <Select
          label="Trạng thái"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[
            { value: "", label: "Tất cả" },
            { value: "active", label: "Đang hoạt động" },
            { value: "blocked", label: "Đã khóa" },
          ]}
        />
        <Button variant="secondary" onClick={load} icon="refresh">Tải lại</Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
          Chưa có CTV nào có mã giới thiệu.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[1180px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["CTV", "Mã", "Trạng thái", "Lượt mở", "Đăng ký", "Đã mua", "Tỷ lệ / N", "Số dư", "Tổng nhận", ""].map((label) => (
                  <th key={label} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <p className="font-mono text-[12px] text-text-main">{row.email}</p>
                    <p className="text-xs text-text-muted">
                      {row.displayName || "—"}
                      {row.sharedIp ? " · trùng IP với người được giới thiệu" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted">{row.code}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={row.status === "blocked" ? "error" : "success"} dot>
                      {row.status === "blocked" ? "Đã khóa" : "Hoạt động"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted">{row.clickCount}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted">{row.signups}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted">{row.payingReferrals}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">
                    {row.rateBp == null ? `mặc định (${(row.effective.rateBp / 100).toFixed(2)}%)` : `${(row.effective.rateBp / 100).toFixed(2)}%`}
                    {" / "}
                    {row.maxOrders == null ? `mặc định (${row.effective.maxOrders})` : row.effective.maxOrders}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap">
                    <span className={row.wallet?.VND?.available < 0 ? "text-danger" : "text-text-main"}>
                      {money("VND", row.wallet?.VND?.available ?? 0)}
                    </span>
                    <span className="text-text-muted"> · </span>
                    <span className={row.wallet?.USD?.available < 0 ? "text-danger" : "text-text-main"}>
                      {money("USD", row.wallet?.USD?.available ?? 0)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">
                    {money("VND", row.earned.VND)} · {money("USD", row.earned.USD)}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => onShowReferrals(row)}>Đã giới thiệu</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>Quản lý</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">{total} CTV · trang {page}/{totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Trước</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Sau</Button>
          </div>
        </div>
      )}

      {editing && (
        <AffiliateModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            onNotice({ tone: "ok", text });
            load();
          }}
          onError={(text) => onNotice({ tone: "error", text })}
        />
      )}
    </section>
  );
}

function AffiliateModal({ row, onClose, onSaved, onError }) {
  const [ratePercent, setRatePercent] = useState(row.rateBp == null ? "" : bpToPercentText(row.rateBp));
  const [maxOrders, setMaxOrders] = useState(row.maxOrders == null ? "" : String(row.maxOrders));
  const [buyerPercent, setBuyerPercent] = useState(row.buyerBonusBp == null ? "" : bpToPercentText(row.buyerBonusBp));
  const [buyerMaxOrders, setBuyerMaxOrders] = useState(row.buyerBonusMaxOrders == null ? "" : String(row.buyerBonusMaxOrders));
  const [giftCodeId, setGiftCodeId] = useState(row.giftCodeId || "");
  const [status, setStatus] = useState(row.status || "active");
  const [adminNote, setAdminNote] = useState(row.adminNote || "");
  const [codes, setCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adjust, setAdjust] = useState({ currency: "VND", delta: "", reason: "" });
  const [adjustBusy, setAdjustBusy] = useState(false);

  useEffect(() => {
    fetch("/api/affiliates/gift-codes", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { codes: [] }))
      .then((body) => setCodes(Array.isArray(body.codes) ? body.codes : []))
      .catch(() => setCodes([]));
  }, []);

  const save = async () => {
    setError("");
    const rateBp = ratePercent.trim() === "" ? null : percentTextToBp(ratePercent);
    if (ratePercent.trim() !== "" && (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000)) {
      setError("Tỷ lệ phải từ 0 đến 100%, tối đa 2 chữ số thập phân.");
      return;
    }
    let maxOrdersValue = null;
    if (maxOrders.trim() !== "") {
      maxOrdersValue = parseCountInput(maxOrders);
      if (maxOrdersValue === null || maxOrdersValue > 1000) {
        setError("Số đơn phải là số nguyên từ 0 đến 1000.");
        return;
      }
    }

    const buyerBp = buyerPercent.trim() === "" ? null : percentTextToBp(buyerPercent);
    if (buyerPercent.trim() !== "" && (!Number.isInteger(buyerBp) || buyerBp < 0 || buyerBp > 10000)) {
      setError("Quà người được giới thiệu phải từ 0 đến 100%.");
      return;
    }
    let buyerMaxValue = null;
    if (buyerMaxOrders.trim() !== "") {
      buyerMaxValue = parseCountInput(buyerMaxOrders);
      if (buyerMaxValue === null || buyerMaxValue > 1000) {
        setError("Số đơn được quà phải là số nguyên từ 0 đến 1000.");
        return;
      }
    }

    // Only what the admin changed. Re-sending an untouched gift override that has
    // since expired made the server refuse the whole save, blocking included.
    const patch = {};
    if (rateBp !== (row.rateBp ?? null)) patch.rateBp = rateBp;
    if (maxOrdersValue !== (row.maxOrders ?? null)) patch.maxOrders = maxOrdersValue;
    if (buyerBp !== (row.buyerBonusBp ?? null)) patch.buyerBonusBp = buyerBp;
    if (buyerMaxValue !== (row.buyerBonusMaxOrders ?? null)) patch.buyerBonusMaxOrders = buyerMaxValue;
    if ((giftCodeId || null) !== (row.giftCodeId || null)) patch.giftCodeId = giftCodeId || null;
    if (status !== (row.status || "active")) patch.status = status;
    if ((adminNote.trim() || null) !== (row.adminNote || null)) patch.adminNote = adminNote;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/affiliates/${row.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, reason: "Điều chỉnh CTV từ trang Affiliate" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không lưu được thay đổi");
        return;
      }
      onSaved("Đã lưu thay đổi cho CTV.");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  };

  const submitAdjust = async () => {
    setError("");
    // Typed in đồng or in dollars, like every other money field on this page.
    const delta = parseSignedAmountInput(adjust.currency, adjust.delta);
    if (delta === null) {
      setError(adjust.currency === "VND"
        ? "Số tiền điều chỉnh phải là số đồng khác 0, ví dụ 50000 hoặc -50.000."
        : "Số tiền điều chỉnh phải là số USD khác 0, ví dụ 2.50 hoặc -2.50.");
      return;
    }
    if (adjust.reason.trim().length < 3) {
      setError("Nhập lý do điều chỉnh (ít nhất 3 ký tự).");
      return;
    }
    setAdjustBusy(true);
    try {
      const res = await fetch(`/api/affiliates/${row.userId}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: adjust.currency, delta, reason: adjust.reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không điều chỉnh được số dư");
        return;
      }
      onError?.("");
      onSaved("Đã điều chỉnh số dư.");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setAdjustBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`CTV ${row.email}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button onClick={save} loading={busy}>Lưu</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Bỏ trống một trường để dùng giá trị mặc định của chương trình.
        </p>
        <Input
          label="Tỷ lệ riêng (%)"
          value={ratePercent}
          onChange={(e) => setRatePercent(e.target.value)}
          placeholder={`mặc định ${(row.effective.rateBp / 100).toFixed(2)}`}
          inputMode="decimal"
        />
        <Input
          label="Số đơn riêng (N)"
          value={maxOrders}
          onChange={(e) => setMaxOrders(e.target.value)}
          placeholder={`mặc định ${row.effective.maxOrders}`}
          inputMode="numeric"
          hint="0 = mọi đơn"
        />
        <Input
          label="Quà người được giới thiệu riêng (%)"
          value={buyerPercent}
          onChange={(e) => setBuyerPercent(e.target.value)}
          placeholder="theo mặc định"
          inputMode="decimal"
          hint="% credit thêm mỗi đơn; gói không giới hạn: % giảm giá"
        />
        <Input
          label="Số đơn được quà riêng"
          value={buyerMaxOrders}
          onChange={(e) => setBuyerMaxOrders(e.target.value)}
          placeholder="theo mặc định"
          inputMode="numeric"
          hint="0 = mọi đơn"
        />
        <Select
          label="Mã quà tặng riêng"
          value={giftCodeId}
          onChange={(e) => setGiftCodeId(e.target.value)}
          options={[
            { value: "", label: "Theo mặc định" },
            ...codes.map((code) => ({
              value: code.id,
              label: giftOptionLabel(code),
            })),
          ]}
        />
        <Select
          label="Trạng thái"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "active", label: "Hoạt động" },
            { value: "blocked", label: "Khóa" },
          ]}
        />
        <Input label="Ghi chú nội bộ" value={adminNote} onChange={(e) => setAdminNote(e.target.value)} />

        <div className="border-t border-border pt-4">
          <p className="meta text-text-muted">Điều chỉnh số dư</p>
          <div className="mt-3 flex flex-col gap-3">
            <Select
              label="Đơn vị"
              value={adjust.currency}
              onChange={(e) => setAdjust({ ...adjust, currency: e.target.value })}
              options={[
                { value: "VND", label: "VND (đồng)" },
                { value: "USD", label: "USD" },
              ]}
            />
            <Input
              label={`Số tiền (${adjust.currency === "VND" ? "đồng" : "USD"})`}
              value={adjust.delta}
              onChange={(e) => setAdjust({ ...adjust, delta: e.target.value })}
              hint="Số âm để trừ."
              inputMode="decimal"
            />
            <Input
              label="Lý do"
              value={adjust.reason}
              onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}
            />
            <div>
              <Button variant="secondary" onClick={submitAdjust} loading={adjustBusy}>Điều chỉnh</Button>
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Commissions ───────────────────────────────────────────────────────────

function CommissionsTab({ onNotice }) {
  const [acting, setActing] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [affiliateUserId, setAffiliateUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (status) params.set("status", status);
      if (affiliateUserId) params.set("affiliateUserId", affiliateUserId.trim());
      const res = await fetch(`/api/affiliates/commissions?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được hoa hồng");
      setRows(Array.isArray(body.commissions) ? body.commissions : []);
      setTotal(Number(body.total) || 0);
    } catch (e) {
      setError(e.message || "Không tải được hoa hồng");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, status, affiliateUserId]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Trạng thái"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[
            { value: "", label: "Tất cả" },
            { value: "pending", label: "Đang giữ" },
            { value: "available", label: "Khả dụng" },
            { value: "reversed", label: "Đã hủy" },
          ]}
        />
        <Input
          label="ID CTV"
          value={affiliateUserId}
          onChange={(e) => { setAffiliateUserId(e.target.value); setPage(1); }}
          placeholder="userId"
        />
        <Button variant="secondary" onClick={load} icon="refresh">Tải lại</Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
          Chưa có hoa hồng nào.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Ngày", "CTV", "Người mua", "Đơn", "Tỷ lệ", "Hoa hồng", "Trạng thái", "Khả dụng từ", ""].map((label) => (
                  <th key={label} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const state = COMMISSION_STATUS[row.status] || { label: row.status, tone: "neutral" };
                return (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtDate(row.createdAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{row.affiliateEmail || row.affiliateUserId}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{row.buyerEmail || "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{money(row.currency, row.baseAmount)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{(row.rateBp / 100).toFixed(2)}%</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{money(row.currency, row.amount)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><Badge variant={BADGE_TONE[state.tone] || "default"} dot>{state.label}</Badge></td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtDate(row.availableAt)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {row.status !== "reversed" && (
                        <div className="flex justify-end gap-2">
                          {row.status === "pending" && (
                            <Button size="sm" variant="secondary" onClick={() => setActing({ row, action: "release" })}>Duyệt ngay</Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setActing({ row, action: "reverse" })}>Hủy</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">{total} dòng · trang {page}/{totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Trước</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Sau</Button>
          </div>
        </div>
      )}
      {acting && (
        <CommissionActionModal
          row={acting.row}
          action={acting.action}
          onClose={() => setActing(null)}
          onDone={(text) => {
            setActing(null);
            onNotice({ tone: "ok", text });
            load();
          }}
        />
      )}
    </section>
  );
}

/**
 * Confirm one commission action. Early release needs no reason (it only moves the
 * hold date); a cancel does, and says what happens to money already available.
 */
function CommissionActionModal({ row, action, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isReverse = action === "reverse";

  const submit = async () => {
    setError("");
    const typed = reason.trim();
    if ((isReverse || typed) && (typed.length < 3 || typed.length > 500)) {
      setError(isReverse ? "Cần ghi lý do (3–500 ký tự) khi hủy hoa hồng" : "Ghi chú phải có từ 3 đến 500 ký tự");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/affiliates/commissions/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không thực hiện được");
      onDone(isReverse ? "Đã hủy khoản hoa hồng" : "Đã duyệt khoản hoa hồng, CTV dùng được ngay");
    } catch (e) {
      setError(e.message || "Không thực hiện được");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isReverse ? "Hủy hoa hồng" : "Duyệt hoa hồng ngay"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Đóng</Button>
          <Button variant={isReverse ? "danger" : "primary"} onClick={submit} loading={busy}>
            {isReverse ? "Hủy hoa hồng" : "Duyệt ngay"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-muted">CTV</dt>
          <dd className="font-mono text-[12px] text-text-main">{row.affiliateEmail || row.affiliateUserId}</dd>
          <dt className="text-text-muted">Người mua</dt>
          <dd className="font-mono text-[12px] text-text-main">{row.buyerEmail || "—"}</dd>
          <dt className="text-text-muted">Hoa hồng</dt>
          <dd className="font-mono text-[12px] text-text-main">{money(row.currency, row.amount)}</dd>
        </dl>
        <p className="text-xs text-text-muted">
          {isReverse
            ? row.status === "available"
              ? "Khoản này đã vào số dư của CTV: hủy sẽ trừ lại đúng số tiền này (số dư có thể âm nếu CTV đã dùng)."
              : "Khoản này đang giữ: hủy thì CTV không bao giờ nhận được nó."
            : `Bỏ thời gian giữ (đến ${fmtDate(row.availableAt)}): khoản này vào số dư của CTV ngay.`}
        </p>
        <Input
          label={isReverse ? "Lý do (bắt buộc)" : "Ghi chú (không bắt buộc)"}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Referrals ─────────────────────────────────────────────────────────────

const USER_STATUS_LABEL = { suspended: "đã khóa", unverified: "chưa xác minh email" };

/** Sum of the non-cancelled commission per currency, split held / available. */
function referralEarnings(commissions = []) {
  const out = { VND: { pending: 0, available: 0 }, USD: { pending: 0, available: 0 } };
  for (const c of commissions) {
    if (!out[c.currency] || (c.status !== "pending" && c.status !== "available")) continue;
    out[c.currency][c.status] += Number(c.amount) || 0;
  }
  return out;
}

function ReferralsTab({ affiliate, onClearAffiliate, onNotice }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detaching, setDetaching] = useState(null);

  const affiliateUserId = affiliate?.userId || "";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (q.trim()) params.set("q", q.trim());
      if (affiliateUserId) params.set("affiliateUserId", affiliateUserId);
      const res = await fetch(`/api/affiliates/referrals?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được danh sách giới thiệu");
      setRows(Array.isArray(body.referrals) ? body.referrals : []);
      setTotal(Number(body.total) || 0);
    } catch (e) {
      setError(e.message || "Không tải được danh sách giới thiệu");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, q, affiliateUserId]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Tìm"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="email hoặc mã CTV"
        />
        {affiliate && (
          <div className="flex h-9 items-center gap-2 border border-border px-3 text-sm">
            <span className="text-text-muted">CTV:</span>
            <span className="font-mono text-[12px] text-text-main">{affiliate.email}</span>
            <button
              type="button"
              onClick={() => { onClearAffiliate(); setPage(1); }}
              className="text-text-muted hover:text-text-main"
              aria-label="Bỏ lọc theo CTV"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
            </button>
          </div>
        )}
        <Button variant="secondary" onClick={load} icon="refresh">Tải lại</Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
          Chưa có tài khoản nào đăng ký qua lời giới thiệu.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Người được giới thiệu", "CTV", "Gắn từ", "Đơn đã trả", "Hoa hồng", ""].map((label) => (
                  <th key={label} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const earned = referralEarnings(row.commissions);
                return (
                  <tr key={row.userId} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5">
                      <a href={`/dashboard/users/${encodeURIComponent(row.userId)}`} className="font-mono text-[12px] text-text-main underline-offset-2 hover:underline">
                        {row.email}
                      </a>
                      <p className="text-xs text-text-muted">
                        Đăng ký {fmtDate(row.signedUpAt)}
                        {row.userStatus && row.userStatus !== "active" ? ` · ${USER_STATUS_LABEL[row.userStatus] || "không hoạt động"}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="font-mono text-[12px] text-text-main">{row.affiliateEmail || row.affiliateUserId}</p>
                      <p className="font-mono text-[11px] text-text-muted">{row.affiliateCode || "—"}</p>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtDate(row.referredAt || row.signedUpAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted">{row.paidOrders}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap">
                      <p className="text-text-muted">Đang giữ {money("VND", earned.VND.pending)} · {money("USD", earned.USD.pending)}</p>
                      <p className="text-text-main">Khả dụng {money("VND", earned.VND.available)} · {money("USD", earned.USD.available)}</p>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setDetaching(row)}>Gỡ giới thiệu</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">{total} tài khoản · trang {page}/{totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Trước</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Sau</Button>
          </div>
        </div>
      )}

      {detaching && (
        <DetachReferrerModal
          row={detaching}
          onClose={() => setDetaching(null)}
          onDone={(text) => {
            setDetaching(null);
            onNotice({ tone: "ok", text });
            load();
          }}
        />
      )}
    </section>
  );
}

/**
 * Remove an account's referrer (PATCH /api/users/[id]/referrer). Later orders stop
 * earning; commissions already recorded stay until cancelled in "Hoa hồng".
 */
function DetachReferrerModal({ row, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (reason.trim().length < 3) {
      setError("Cần ghi lý do (3–500 ký tự)");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(row.userId)}/referrer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referrerUserId: null, reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không gỡ được người giới thiệu");
      onDone(`Đã gỡ người giới thiệu của ${row.email}`);
    } catch (e) {
      setError(e.message || "Không gỡ được người giới thiệu");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Gỡ người giới thiệu"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Đóng</Button>
          <Button variant="danger" onClick={submit} loading={busy}>Gỡ</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-main">
          <span className="font-mono text-[12px]">{row.email}</span> sẽ không còn thuộc CTV{" "}
          <span className="font-mono text-[12px]">{row.affiliateEmail || row.affiliateUserId}</span>.
        </p>
        <p className="text-xs text-text-muted">
          Các đơn sau này không tạo hoa hồng cho CTV này nữa. Hoa hồng đã ghi vẫn giữ nguyên: muốn thu hồi thì hủy từng khoản ở tab Hoa hồng.
        </p>
        <Input label="Lý do (bắt buộc)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Vouchers ──────────────────────────────────────────────────────────────

const VOUCHER_STATUS = {
  active: { label: "Chưa dùng", tone: "success" },
  used: { label: "Đã dùng", tone: "neutral" },
  cancelled: { label: "Đã hủy", tone: "danger" },
};

function VouchersTab() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (status) params.set("status", status);
      const res = await fetch(`/api/affiliates/vouchers?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được voucher");
      setRows(Array.isArray(body.vouchers) ? body.vouchers : []);
      setTotal(Number(body.total) || 0);
    } catch (e) {
      setError(e.message || "Không tải được voucher");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Trạng thái"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[
            { value: "", label: "Tất cả" },
            { value: "active", label: "Chưa dùng" },
            { value: "used", label: "Đã dùng" },
            { value: "cancelled", label: "Đã hủy" },
          ]}
        />
        <Button variant="secondary" onClick={load} icon="refresh">Tải lại</Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
          Chưa có voucher nào.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Ngày tạo", "Mã", "CTV", "Giá trị", "Trạng thái", "Người dùng", "Đơn", "Lúc dùng"].map((label) => (
                  <th key={label} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const state = VOUCHER_STATUS[row.status] || { label: row.status, tone: "neutral" };
                return (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtDate(row.createdAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{row.code}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{row.ownerEmail || row.ownerUserId}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{money(row.currency, row.amount)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><Badge variant={BADGE_TONE[state.tone] || "default"} dot>{state.label}</Badge></td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{row.usedByEmail || "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{row.usedOrderId ? row.usedOrderId.slice(0, 8) : "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtDate(row.usedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">{total} dòng · trang {page}/{totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Trước</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Sau</Button>
          </div>
        </div>
      )}
    </section>
  );
}
