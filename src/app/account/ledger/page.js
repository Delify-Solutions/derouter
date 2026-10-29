import LedgerTable from "./LedgerTable";

export const metadata = {
  title: "Sổ cái - derouter",
};

export const dynamic = "force-dynamic";

// Every credit movement of the signed-in customer: grants, charges, expiries and
// adjustments, with the request each charge paid for.
export default function AccountLedgerPage() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Tài khoản</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">Sổ cái</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          Mọi thay đổi credit của bạn, mới nhất trước. Dòng “Trừ tiền” ghi model và số token mà
          khoản đó đã trả.
        </p>
      </header>

      <LedgerTable />
    </div>
  );
}
