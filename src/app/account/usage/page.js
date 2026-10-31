import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { USER_COOKIE, verifyUserToken } from "@/lib/auth/userSession";
import { getApiKeys, getKeyUsageSummary, getUsageHistory, getUserById } from "@/lib/db/index.js";
import { fmtUsd, fmtUsdNano } from "@/shared/utils/money";
import { percentLabel } from "@/shared/utils/discountFormat";
import { Empty, Page, ButtonLink } from "@/app/account/components/ui";
import AccountUsageTable from "./AccountUsageTable";

export const dynamic = "force-dynamic";

const PERIODS = [
  { id: "24h", label: "24h", ms: 86_400_000 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
  { id: "60d", label: "60d", ms: 60 * 86_400_000 },
];

const HISTORY_LIMIT = 50;

function periodRange(period) {
  const ms = PERIODS.find((p) => p.id === period)?.ms ?? 7 * 86_400_000;
  const now = new Date();
  return { startDate: new Date(now.getTime() - ms).toISOString(), endDate: now.toISOString() };
}

function normalizeStatus(s) {
  if (s == null || s === "") return "—";
  const lower = String(s).toLowerCase();
  if (lower === "ok" || lower === "success" || lower === "completed") return "200";
  const n = Number(s);
  if (!Number.isNaN(n) && n >= 100 && n < 600) return String(Math.trunc(n));
  return String(s);
}

function toRow(r) {
  const t = r.tokens || {};
  const input = t.prompt_tokens ?? t.input_tokens ?? 0;
  const output = t.completion_tokens ?? t.output_tokens ?? 0;
  const latencyMs = r.meta?.latencyMs ?? null;
  return {
    timestamp: r.timestamp,
    model: r.model || "—",
    status: normalizeStatus(r.status),
    latencyMs,
    input,
    output,
    tok: input + output,
    tokS: latencyMs && latencyMs > 0 ? Math.round((output / (latencyMs / 1000)) * 10) / 10 : null,
    cacheRead: t.cached_tokens ?? t.cache_read_input_tokens ?? t.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreation: t.cache_creation_input_tokens ?? 0,
    costLabel: fmtUsd(r.cost ?? 0),
    // A discounted request shows what it would have cost at list price and how
    // much was taken off (spec model-discounts "Receipts").
    discountLabel: r.meta?.discountBp > 0 ? `giảm ${percentLabel(r.meta.discountBp)}` : null,
    listCostLabel: r.meta?.discountBp > 0 && r.meta?.listCostNanoUsd != null ? fmtUsdNano(r.meta.listCostNanoUsd) : null,
  };
}

// Account usage: read-only view of every key the signed-in customer owns.
//
// The plaintext key never leaves the server (the account keys API exposes only a
// prefix), so the receipts are assembled here from the same repo functions the
// public /api/usage/key/receipts route uses, and only the aggregated rows reach
// the client component.
export default async function AccountUsagePage({ searchParams }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_COOKIE)?.value;
  const claims = token ? await verifyUserToken(token) : null;
  if (!claims) redirect("/login");

  const user = await getUserById(claims.userId);
  if (!user) redirect("/login");

  const keys = (await getApiKeys()).filter((key) => key.userId === claims.userId);

  const params = (await searchParams) || {};
  const period = PERIODS.some((p) => p.id === params.period) ? params.period : "7d";
  const selected = keys.find((key) => key.id === params.key) || keys[0] || null;

  let summary = null;
  let history = [];
  if (selected) {
    const { startDate, endDate } = periodRange(period);
    const [keySummary, rows] = await Promise.all([
      getKeyUsageSummary(selected.key, { startDate, endDate }),
      getUsageHistory({ apiKey: selected.key, startDate, endDate }),
    ]);
    summary = keySummary;
    history = rows
      .slice()
      .reverse()
      .slice(0, HISTORY_LIMIT)
      .map(toRow);
  }

  const keysView = keys.map((key) => ({
    id: key.id,
    name: key.name || "Key chưa đặt tên",
    keyPrefix: key.keyPrefix || key.key?.slice(0, 8) || "",
    isActive: key.isActive,
    createdAt: key.createdAt,
  }));

  const totals = summary?.totals || { requests: 0, input: 0, output: 0 };
  const totalsView = {
    requests: totals.requests || 0,
    input: totals.input || 0,
    output: totals.output || 0,
    tokens: (totals.input || 0) + (totals.output || 0),
    costLabel: fmtUsd(totals.cost || 0),
  };

  return (
    <Page
      title="Lịch sử dùng"
      description="Mọi request gọi bằng key của bạn, mới nhất trước. Thanh toán trả trước: mỗi dòng trừ vào credit của gói đã dùng."
    >
      {keysView.length === 0 ? (
        <Empty
          icon="monitoring"
          title="Bạn chưa có API key"
          body="Lịch sử xuất hiện ở đây sau khi bạn tạo key và gửi request đầu tiên."
          action={<ButtonLink href="/account/keys" tone="solid">Tạo key</ButtonLink>}
        />
      ) : (
        <AccountUsageTable
          keys={keysView}
          selectedKeyId={selected?.id || null}
          period={period}
          periods={PERIODS.map(({ id, label }) => ({ id, label }))}
          totals={totalsView}
          rows={history}
          historyLimit={HISTORY_LIMIT}
        />
      )}
    </Page>
  );
}
