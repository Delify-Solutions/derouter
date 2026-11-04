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

const WITHDRAWAL_STATUS = {
  pending: { label: "Chờ xử lý", tone: "warning" },
  paid: { label: "Đã chuyển", tone: "success" },
  rejected: { label: "Từ chối", tone: "danger" },
};

/** Money in its own currency. Never combined, never converted (spec "Commission wallet"). */
function money(currency, value) {
  return currency === "VND" ? formatVnd(value) : fmtUsdNano(value);
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
  // Bumped after a withdrawal so the history table reloads with the new row.
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

  const { enabled, wallet, payout, minWithdraw } = data;
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
          description={termsSentence(data.rateBp, data.maxOrders)}
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
          withdrawal list (spec "Program settings"). No stats, no forms, no link. */}
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
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted text-right">Đã rút</th>
              </tr>
            </thead>
            <tbody>
              {["VND", "USD"].map((currency) => {
                const row = wallet?.[currency] ?? { available: 0, pending: 0, earned: 0, withdrawn: 0 };
                return (
                  <tr key={currency} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-text-main">{currency}</td>
                    <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${row.available < 0 ? "text-danger" : "text-text-main"}`}>
                      {money(currency, row.available)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.pending)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.earned)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-text-muted">{money(currency, row.withdrawn)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(wallet?.VND?.available < 0 || wallet?.USD?.available < 0) ? (
          <p className="mt-3 text-sm text-danger">
            Số dư âm do một đơn đã hoàn tiền sau khi hoa hồng được cộng. Hoa hồng mới sẽ bù lại trước khi rút được.
          </p>
        ) : null}
      </Section>

      {enabled ? (
        <>
          <PayoutSection payout={payout} onSaved={() => load({ silent: true })} />
          <WithdrawSection
            wallet={wallet}
            minWithdraw={minWithdraw}
            blocked={blocked}
            payout={payout}
            onDone={() => {
              load({ silent: true });
              setVersion((v) => v + 1);
            }}
          />
        </>
      ) : (
        <Section
          title="Rút tiền"
          description="Chương trình đang tắt nên chưa gửi được lệnh rút mới. Số dư và các lệnh đã gửi vẫn được giữ nguyên."
        >
          <Empty icon="link_off" title="Tạm dừng rút tiền" body="Quản trị viên bật lại chương trình thì mục này hoạt động như cũ." />
        </Section>
      )}
      {enabled ? <CommissionsTable /> : null}
      {enabled ? <ReferralsTable /> : null}
      <WithdrawalsTable version={version} />
    </Page>
  );
}

function PayoutSection({ payout, onSaved }) {
  const [vnd, setVnd] = useState({ bankName: "", accountNumber: "", accountName: "" });
  const [usd, setUsd] = useState({ network: "TRC20", address: "" });
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState({});

  useEffect(() => {
    if (payout?.vnd) setVnd({ bankName: "", accountNumber: "", accountName: "", ...payout.vnd });
    if (payout?.usd) setUsd({ network: "TRC20", address: "", ...payout.usd });
  }, [payout]);

  const save = async (currency) => {
    setSaving(currency);
    setMessage((prev) => ({ ...prev, [currency]: "" }));
    try {
      const res = await fetch("/api/account/affiliate/payout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currency === "VND" ? { currency, ...vnd } : { currency, ...usd }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage((prev) => ({ ...prev, [currency]: body.error || "Không lưu được thông tin" }));
        return;
      }
      setMessage((prev) => ({ ...prev, [currency]: "Đã lưu thông tin nhận tiền." }));
      if (onSaved) onSaved();
    } catch {
      setMessage((prev) => ({ ...prev, [currency]: "Không kết nối được máy chủ." }));
    } finally {
      setSaving("");
    }
  };

  return (
    <Section
      title="Thông tin nhận tiền"
      description="Chỉ bạn và quản trị viên thấy thông tin này. Lệnh rút đã tạo giữ bản sao riêng, sửa sau không ảnh hưởng."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <Eyebrow>Chuyển khoản (VND)</Eyebrow>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-2">
              <span className="meta text-text-muted">Ngân hàng</span>
              <input className={fieldClass} value={vnd.bankName} maxLength={100}
                onChange={(e) => setVnd({ ...vnd, bankName: e.target.value })} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="meta text-text-muted">Số tài khoản</span>
              <input className={fieldClass} value={vnd.accountNumber} maxLength={100} inputMode="numeric"
                onChange={(e) => setVnd({ ...vnd, accountNumber: e.target.value })} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="meta text-text-muted">Chủ tài khoản</span>
              <input className={fieldClass} value={vnd.accountName} maxLength={100}
                onChange={(e) => setVnd({ ...vnd, accountName: e.target.value })} />
            </label>
            {message.VND ? <p className="text-sm text-text-muted">{message.VND}</p> : null}
            <ActionButton onClick={() => save("VND")} loading={saving === "VND"}>Lưu VND</ActionButton>
          </div>
        </Panel>

        <Panel className="p-5">
          <Eyebrow>USDT / Binance (USD)</Eyebrow>
          <div className="mt-4 flex flex-col gap-3">
            <SelectField
              id="payout-network"
              label="Mạng"
              value={usd.network}
              onChange={(e) => setUsd({ ...usd, network: e.target.value })}
              options={[
                { value: "TRC20", label: "TRC20" },
                { value: "BEP20", label: "BEP20" },
                { value: "BINANCE", label: "Binance Pay ID" },
              ]}
            />
            <label className="flex flex-col gap-2">
              <span className="meta text-text-muted">Địa chỉ ví hoặc Binance ID</span>
              <input className={fieldClass} value={usd.address} maxLength={100}
                onChange={(e) => setUsd({ ...usd, address: e.target.value })} />
            </label>
            {message.USD ? <p className="text-sm text-text-muted">{message.USD}</p> : null}
            <ActionButton onClick={() => save("USD")} loading={saving === "USD"}>Lưu USD</ActionButton>
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function WithdrawSection({ wallet, minWithdraw, blocked, payout, onDone }) {
  const [currency, setCurrency] = useState("VND");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const available = Number(wallet?.[currency]?.available ?? 0);
  const minimum = Number(minWithdraw?.[currency] ?? 0);
  const hasPayout = currency === "VND" ? Boolean(payout?.vnd) : Boolean(payout?.usd);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setDone("");
    // Typed as shown on screen: đồng for VND ("200.000"), dollars for USD ("12.50").
    // The API takes integer đồng / nano-USD.
    const value = currency === "VND" ? parseVndInput(amount) : parseUsdInput(amount);
    if (value === null || value <= 0) {
      setError(currency === "VND"
        ? "Nhập số tiền bằng đồng, ví dụ 200000 hoặc 200.000."
        : "Nhập số tiền bằng USD, ví dụ 12.50.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/account/affiliate/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency, amount: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không tạo được lệnh rút.");
        return;
      }
      setDone("Đã tạo lệnh rút. Quản trị viên sẽ xử lý và bạn thấy kết quả trong lịch sử.");
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
      title="Rút hoa hồng"
      description={`Tối thiểu ${formatVnd(minWithdraw?.VND ?? 0)} cho VND, ${fmtUsdNano(minWithdraw?.USD ?? 0)} cho USD. Mỗi đơn vị chỉ có một lệnh chờ xử lý.`}
    >
      <Panel className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              id="withdraw-currency"
              label="Đơn vị"
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
          {!hasPayout ? (
            <p className="text-sm text-text-muted">Lưu thông tin nhận tiền cho {currency} trước khi rút.</p>
          ) : null}
          {blocked ? <p className="text-sm text-danger">Tài khoản đang bị khóa nên chưa rút được.</p> : null}
          {error ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-danger">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
              {error}
            </p>
          ) : null}
          {done ? <p role="status" className="text-sm text-brand-700 dark:text-brand-400">{done}</p> : null}
          <ActionButton type="submit" tone="solid" loading={pending} disabled={blocked || !hasPayout}>
            Gửi lệnh rút
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

  // `version` comes from the parent: a new withdrawal reloads the history.
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

function WithdrawalsTable({ version = 0 }) {
  const columns = ["Thời điểm", "Đơn vị", "Số tiền", "Trạng thái", "Ghi chú"];
  return (
    <PagedTable
      title="Lịch sử rút"
      description="Mỗi lệnh rút giữ số tiền lại cho đến khi quản trị viên chuyển khoản hoặc từ chối."
      endpoint="/api/account/affiliate/withdrawals"
      field="withdrawals"
      version={version}
      emptyTitle="Chưa có lệnh rút"
      emptyBody="Khi số dư khả dụng đạt mức tối thiểu, bạn gửi được lệnh rút ở trên."
      columns={columns}
      renderRow={(row) => {
        const status = WITHDRAWAL_STATUS[row.status] || { label: row.status, tone: "neutral" };
        return (
          <tr key={row.id} className="border-b border-border last:border-b-0">
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{dateOf(row.createdAt)}</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-muted whitespace-nowrap">{row.currency}</td>
            <td className="px-4 py-2.5 font-mono text-[12px] text-text-main whitespace-nowrap">{money(row.currency, row.amount)}</td>
            <td className="px-4 py-2.5 whitespace-nowrap"><Tag tone={status.tone}>{status.label}</Tag></td>
            <td className="px-4 py-2.5 text-sm text-text-muted">{row.adminNote || (row.txRef ? `Mã giao dịch ${row.txRef}` : "—")}</td>
          </tr>
        );
      }}
    />
  );
}
