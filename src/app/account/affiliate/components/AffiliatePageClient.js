"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import {
  ActionButton,
  Empty,
  Eyebrow,
  Page,
  Panel,
  Section,
  SelectField,
  Stat,
  Tag,
  fieldClass,
} from "@/app/account/components/ui";
import CopyBlock from "@/app/account/components/CopyBlock";
import { dateOf } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import { parseUsdInput, parseVndInput } from "@/lib/affiliate/amountInput.js";

const PAGE_SIZE = 20;

const COMMISSION_STATUS = {
  pending: { label: "Đang giữ", tone: "warning" },
  available: { label: "Khả dụng", tone: "success" },
  reversed: { label: "Đã hoàn", tone: "danger" },
};

const VOUCHER_STATUS = {
  active: { label: "Chưa dùng", tone: "success" },
  used: { label: "Đã dùng", tone: "neutral" },
  cancelled: { label: "Đã hủy", tone: "danger" },
};

/** Money in its own currency. Never combined, never converted (spec "Commission wallet"). */
function money(currency, value) {
  return currency === "VND" ? formatVnd(value) : fmtUsdNano(value);
}

function percentOf(bp) {
  return (Number(bp) / 100).toFixed(Number(bp) % 100 === 0 ? 0 : 2);
}

function buyerBonusSentence(bp, maxOrders) {
  if (!(Number(bp) > 0)) return "";
  const scope = Number(maxOrders) === 0 ? "mỗi đơn" : `${Number(maxOrders)} đơn đầu`;
  return `Người được giới thiệu được tặng thêm ${percentOf(bp)}% credit cho ${scope} (gói không giới hạn: giảm ${percentOf(bp)}% khi thanh toán).`;
}

function termsSentence(rateBp, maxOrders) {
  if (rateBp == null) return "";
  const percent = (Number(rateBp) / 100).toFixed(rateBp % 100 === 0 ? 0 : 2);
  if (Number(maxOrders) === 0) return `Hoa hồng ${percent}% cho mỗi đơn đã thanh toán của người bạn giới thiệu.`;
  const n = Number(maxOrders);
  return `Hoa hồng ${percent}% cho ${n} đơn đầu của mỗi người bạn giới thiệu.`;
}

export default function AffiliatePageClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  // Bumped after a spend so the voucher table reloads with the new row.
  const [version, setVersion] = useState(0);

  // `silent` refreshes in place. Showing the skeleton would unmount the forms and
  // with them the "Đã lưu…" / "Đã tạo lệnh rút…" message the customer just got.
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/account/affiliate", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được trang giới thiệu");
      setData(body);
    } catch (e) {
      setError(e.message || "Không tải được trang giới thiệu");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <CardSkeleton />;
  if (error) {
    return (
      <Page title="Giới thiệu">
        <div role="alert" className="flex items-start justify-between gap-3 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="flex items-start gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
            {error}
          </span>
          <ActionButton size="sm" onClick={() => load()}>Thử lại</ActionButton>
        </div>
      </Page>
    );
  }
  if (!data) return null;

  const { enabled, wallet, redeem } = data;
  const hasHistory = data.hasHistory === true;
  const blocked = data.status === "blocked";

  // The program is off and this account has no history: nothing to show, and the
  // nav item would not be there either.
  if (!enabled && !hasHistory) {
    return (
      <Page title="Giới thiệu">
        <Empty
          icon="group_add"
          title="Chương trình giới thiệu đang tắt"
          body="Khi chương trình được bật, bạn sẽ nhận được đường dẫn giới thiệu và hoa hồng cho mỗi đơn hàng đã thanh toán của người bạn giới thiệu."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Giới thiệu"
      description={enabled
        ? "Chia sẻ đường dẫn của bạn. Người đăng ký qua đường dẫn đó được ghi nhận là do bạn giới thiệu, và bạn nhận hoa hồng trên các đơn họ đã thanh toán."
        : "Chương trình giới thiệu đang tắt. Trang này giữ số dư và lịch sử rút tiền của bạn cho đến khi chương trình bật lại."}
    >
      {enabled && data.link ? (
        <Section
          title="Đường dẫn giới thiệu"
          description={[termsSentence(data.rateBp, data.maxOrders), buyerBonusSentence(data.buyerBonusBp, data.buyerBonusMaxOrders)].filter(Boolean).join(" ")}
        >
          <div className="flex flex-col gap-4">
            <CopyBlock value={data.link} prompt="link" label="Sao chép đường dẫn" />
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={blocked ? "danger" : "success"}>{blocked ? "Đang bị khóa" : "Đang hoạt động"}</Tag>
              {data.code ? <Tag>Mã {data.code}</Tag> : null}
              {blocked ? (
                <span className="text-sm text-text-muted">
                  Đường dẫn tạm ngừng ghi nhận người mới và không phát sinh hoa hồng mới.
                </span>
              ) : null}
            </div>
            {data.giftCode ? (
              <Panel className="p-4">
                <Eyebrow>Quà cho người bạn giới thiệu</Eyebrow>
                <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-text-main">
                  <code className="font-mono font-medium">{data.giftCode}</code>
                  <span className="text-text-muted">Mã người mới, cần liên kết Telegram khi nhập.</span>
                </p>
              </Panel>
            ) : null}
          </div>
        </Section>
      ) : (
        <Section
          title="Chương trình đang tắt"
          description="Chương trình giới thiệu đang tắt nên chưa có đường dẫn mới. Số dư và lịch sử rút tiền của bạn vẫn được giữ."
        >
          <Empty icon="link_off" title="Không có đường dẫn mới" body="Bật lại chương trình để tiếp tục giới thiệu." />
        </Section>
      )}

      {/* With the program off, the page is history only: the wallet and the
          voucher list (spec "Program settings"). No stats, no forms, no link. */}
      {enabled ? (
        <Section title="Hiệu quả" description="Lượt mở link, số tài khoản đăng ký và số người đã phát sinh hoa hồng.">
          <div className="grid gap-6 sm:grid-cols-3">
            <Stat label="Lượt mở link" value={String(data.stats?.clicks ?? 0)} />
            <Stat label="Đăng ký" value={String(data.stats?.signups ?? 0)} />
            <Stat label="Đã phát sinh hoa hồng" value={String(data.stats?.payingReferrals ?? 0)} />
          </div>
        </Section>
      ) : null}

      <Section title="Ví hoa hồng" description="Mỗi đơn vị tiền giữ một số dư riêng. Không quy đổi giữa hai đơn vị.">
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Đơn vị</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right">Khả dụng</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right">Đang giữ</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right">Tổng đã nhận</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right">Đã dùng</th>
              </tr>
            </thead>
            <tbody>
              {["VND", "USD"].map((currency) => {
                const row = wallet?.[currency] ?? { available: 0, pending: 0, earned: 0, spent: 0 };
                return (
                  <tr key={currency} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main">{currency}</td>
                    <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${row.available < 0 ? "text-danger" : "text-text-main"}`}>
                      {money(currency, row.available)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.pending)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.earned)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.spent)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(wallet?.VND?.available < 0 || wallet?.USD?.available < 0) ? (
          <p className="mt-3 text-sm text-danger">
            Số dư âm do một đơn đã hoàn tiền sau khi hoa hồng được cộng. Hoa hồng mới sẽ bù lại trước khi dùng tiếp được.
          </p>
        ) : null}
      </Section>

      {enabled ? (
        <SpendSection
          wallet={wallet}
          redeem={redeem}
          blocked={blocked}
          onDone={() => {
            load({ silent: true });
            setVersion((v) => v + 1);
          }}
        />
      ) : (
        <Section
          title="Dùng hoa hồng"
          description="Chương trình đang tắt nên chưa đổi credit hay tạo voucher mới được. Số dư và voucher đã tạo vẫn được giữ."
        >
          <Empty icon="link_off" title="Tạm dừng" body="Quản trị viên bật lại chương trình thì mục này hoạt động như cũ." />
        </Section>
      )}
      {enabled ? <CommissionsTable /> : null}
      {enabled ? <ReferralsTable /> : null}
      <VouchersTable version={version} onChanged={() => { load({ silent: true }); setVersion((v) => v + 1); }} />
    </Page>
  );
}

/** đồng → nano-USD at the admin rate, floored (BigInt; same maths as the server). */
function previewCreditNano(vnd, vndPerUsd) {
  const rate = BigInt(Math.trunc(Number(vndPerUsd) || 0));
  const amount = BigInt(Math.trunc(Number(vnd) || 0));
  if (rate <= 0n || amount <= 0n) return 0;
  return Number((amount * 1_000_000_000n) / rate);
}

/** The typed amount in the currency's smallest unit, or null. */
function parseAmount(currency, text) {
  return currency === "VND" ? parseVndInput(text) : parseUsdInput(text);
}

/**
 * "Dùng hoa hồng": convert to API credit, or make a voucher. Both spend the
 * wallet the same way; the server re-checks every rule.
 */
function SpendSection({ wallet, redeem, blocked, onDone }) {
  const [mode, setMode] = useState("credit");
  const [currency, setCurrency] = useState("VND");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const available = Number(wallet?.[currency]?.available ?? 0);
  const minimum = currency === "VND" ? Number(redeem?.minVnd ?? 0) : Number(redeem?.minUsdNano ?? 0);
  const parsed = parseAmount(currency, amount);
  const creditPreview = parsed && parsed > 0
    ? (currency === "VND" ? previewCreditNano(parsed, redeem?.vndPerUsd) : parsed)
    : 0;
  const noTemplate = mode === "credit" && !redeem?.templatePlanName;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setDone("");
    if (parsed === null || parsed <= 0) {
      setError(currency === "VND"
        ? "Nhập số tiền bằng đồng, ví dụ 200000 hoặc 200.000."
        : "Nhập số tiền bằng USD, ví dụ 12.50.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(mode === "credit" ? "/api/account/affiliate/convert" : "/api/account/affiliate/vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency, amount: parsed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không thực hiện được.");
        return;
      }
      setDone(mode === "credit"
        ? `Đã cộng ${fmtUsdNano(body.creditNanoUsd)} credit, hết hạn ${dateOf(body.expiresAt)}.`
        : `Đã tạo voucher ${body.voucher?.code}. Sao chép mã ở danh sách bên dưới.`);
      setAmount("");
      if (onDone) onDone();
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Section
      title="Dùng hoa hồng"
      description={`Hoa hồng không rút ra tiền mặt: đổi thành credit dùng API hoặc tạo voucher giảm giá khi mua gói. Tối thiểu ${formatVnd(redeem?.minVnd ?? 0)} hoặc ${fmtUsdNano(redeem?.minUsdNano ?? 0)} mỗi lần.`}
    >
      <Panel className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div role="radiogroup" aria-label="Cách dùng" className="inline-flex w-full border border-border sm:w-auto">
            {[
              { value: "credit", label: "Đổi thành credit" },
              { value: "voucher", label: "Tạo voucher" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                onClick={() => { setMode(option.value); setError(""); setDone(""); }}
                className={`h-9 flex-1 px-4 text-sm transition-colors sm:flex-none ${
                  mode === option.value ? "bg-brand-500 text-white" : "text-text-muted hover:text-text-main"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              id="spend-currency"
              label="Từ ví"
              value={currency}
              onChange={(e) => { setCurrency(e.target.value); setAmount(""); setError(""); setDone(""); }}
              options={[
                { value: "VND", label: "VND" },
                { value: "USD", label: "USD" },
              ]}
            />
            <label className="flex flex-col gap-2">
              <span className="meta text-text-muted">Số tiền ({currency === "VND" ? "đồng" : "USD"})</span>
              <input
                className={fieldClass}
                value={amount}
                inputMode={currency === "VND" ? "numeric" : "decimal"}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={currency === "VND" ? "200.000" : "12.50"}
              />
            </label>
          </div>
          <p className="font-mono text-[12px] text-text-muted">
            Khả dụng {money(currency, available)} · tối thiểu {money(currency, minimum)}
          </p>
          {mode === "credit" ? (
            noTemplate ? (
              <p className="text-sm text-text-muted">Quản trị viên chưa mở đổi credit.</p>
            ) : (
              <p className="text-sm text-text-muted">
                {creditPreview > 0 ? <>Nhận <span className="font-mono text-text-main">{fmtUsdNano(creditPreview)}</span> credit. </> : null}
                Mỗi lần đổi là một khoản riêng, hết hạn sau {redeem?.creditDays ?? 30} ngày, giới hạn tốc độ theo gói {redeem?.templatePlanName}.
                {currency === "VND" && redeem?.vndPerUsd ? ` Tỷ giá ${formatVnd(redeem.vndPerUsd)} = $1.` : ""}
              </p>
            )
          ) : (
            <p className="text-sm text-text-muted">
              Voucher dùng một lần, tặng được cho bất kỳ ai. Giá trị trừ vào giá gói khi thanh toán; phần dư không hoàn lại.
              Hủy voucher chưa dùng để lấy lại tiền vào ví.
            </p>
          )}
          {blocked ? <p className="text-sm text-danger">Tài khoản đang bị khóa giới thiệu nên chưa dùng được hoa hồng.</p> : null}
          {error ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-danger">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
              {error}
            </p>
          ) : null}
          {done ? <p role="status" className="text-sm text-brand-700 dark:text-brand-400">{done}</p> : null}
          <ActionButton type="submit" tone="solid" loading={pending} disabled={blocked || noTemplate}>
            {mode === "credit" ? "Đổi thành credit" : "Tạo voucher"}
          </ActionButton>
        </form>
      </Panel>
    </Section>
  );
}

function PagedTable({ title, description, endpoint, field, emptyTitle, emptyBody, columns, renderRow, version = 0 }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      const res = await fetch(`${endpoint}?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được dữ liệu");
      setRows(Array.isArray(body[field]) ? body[field] : []);
      setTotal(Number(body.total) || 0);
    } catch (e) {
      setError(e.message || "Không tải được dữ liệu");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint, field, page]);

  // `version` comes from the parent: a new voucher reloads the list.
  useEffect(() => { load(); }, [load, version]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Section title={title} description={description}>
      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <Empty title={emptyTitle} body={emptyBody} />
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {columns.map((column) => (
                  <th key={column} scope="col" className="meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{rows.map(renderRow)}</tbody>
          </table>
        </div>
      )}
      {total > PAGE_SIZE ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-text-muted">{total} dòng · trang {page}/{totalPages}</p>
          <div className="flex gap-2">
            <ActionButton size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Trước
            </ActionButton>
            <ActionButton size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Sau
            </ActionButton>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function CommissionsTable() {
  const columns = ["Thời điểm", "Người mua", "Đơn hàng", "Tỷ lệ", "Hoa hồng", "Trạng thái"];
  return (
    <PagedTable
      title="Hoa hồng"
      description="Mỗi đơn đã thanh toán của người bạn giới thiệu tạo một dòng. Hoa hồng được giữ một thời gian trước khi rút được."
      endpoint="/api/account/affiliate/commissions"
      field="commissions"
      emptyTitle="Chưa có hoa hồng"
      emptyBody="Khi người bạn giới thiệu thanh toán một đơn, hoa hồng xuất hiện ở đây."
      columns={columns}
      renderRow={(row) => {
        const status = COMMISSION_STATUS[row.status] || { label: row.status, tone: "neutral" };
        return (
          <tr key={row.id} className="border-b border-border last:border-b-0">
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{dateOf(row.createdAt)}</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{row.buyerEmail || "—"}</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{money(row.currency, row.baseAmount)}</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{(Number(row.rateBp) / 100).toFixed(2)}%</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{money(row.currency, row.amount)}</td>
            <td className="px-4 py-2.5 whitespace-nowrap"><Tag tone={status.tone}>{status.label}</Tag></td>
          </tr>
        );
      }}
    />
  );
}

function ReferralsTable() {
  const columns = ["Người được giới thiệu", "Ngày đăng ký", "Hoa hồng VND", "Hoa hồng USD"];
  return (
    <PagedTable
      title="Người được giới thiệu"
      description="Email được ẩn bớt. Chỉ các đơn đã thanh toán mới hiện số tiền."
      endpoint="/api/account/affiliate/referrals"
      field="referrals"
      emptyTitle="Chưa có người đăng ký"
      emptyBody="Chia sẻ đường dẫn giới thiệu để người mới đăng ký qua bạn."
      columns={columns}
      renderRow={(row) => (
        <tr key={`${row.email}-${row.signedUpAt}`} className="border-b border-border last:border-b-0">
          <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{row.email || "—"}</td>
          <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{dateOf(row.signedUpAt)}</td>
          <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{formatVnd(row.earned?.VND ?? 0)}</td>
          <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{fmtUsdNano(row.earned?.USD ?? 0)}</td>
        </tr>
      )}
    />
  );
}

function VoucherCodeCell({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code stays visible to copy by hand */
    }
  };
  return (
    <span className="flex items-center gap-2">
      <code className="font-mono text-[12px] text-text-main">{code}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Sao chép voucher ${code}`}
        className="flex size-7 items-center justify-center border border-border text-text-muted hover:border-brand-500 hover:text-brand-600"
      >
        <span className="material-symbols-outlined text-[15px]" aria-hidden="true">{copied ? "check" : "content_copy"}</span>
      </button>
    </span>
  );
}

function VouchersTable({ version = 0, onChanged }) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const cancel = async (row) => {
    setBusyId(row.id);
    setError("");
    try {
      const res = await fetch(`/api/account/affiliate/vouchers/${row.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không hủy được voucher.");
        return;
      }
      if (onChanged) onChanged();
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setBusyId("");
    }
  };
  const columns = ["Mã", "Giá trị", "Trạng thái", "Người dùng", "Ngày tạo", ""];
  return (
    <>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <PagedTable
        title="Voucher của bạn"
        description="Gửi mã cho người mua. Mỗi mã dùng một lần khi thanh toán gói."
        endpoint="/api/account/affiliate/vouchers"
        field="vouchers"
        version={version}
        emptyTitle="Chưa có voucher"
        emptyBody="Tạo voucher từ hoa hồng ở mục Dùng hoa hồng."
        columns={columns}
        renderRow={(row) => {
          const status = VOUCHER_STATUS[row.status] || { label: row.status, tone: "neutral" };
          return (
            <tr key={row.id} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2.5 whitespace-nowrap"><VoucherCodeCell code={row.code} /></td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{money(row.currency, row.amount)}</td>
              <td className="px-4 py-2.5 whitespace-nowrap">
                <Tag tone={status.tone}>{row.held ? "Đang gắn với đơn" : status.label}</Tag>
              </td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{row.usedBy || "—"}</td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{dateOf(row.createdAt)}</td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">
                {row.status === "active" && !row.held ? (
                  <ActionButton size="sm" loading={busyId === row.id} onClick={() => cancel(row)}>Hủy</ActionButton>
                ) : null}
              </td>
            </tr>
          );
        }}
      />
    </>
  );
}
