import { fmtUsdNano } from "@/shared/utils/money";

/**
 * Wallet headline. The balance is the single largest figure on the page because
 * it is the one number a customer opens this page to read; everything else is
 * secondary. "Available" already excludes expired credit and unpaid overdraft,
 * so it must never be recomputed here.
 */
export default function WalletSummary({ availableNanoUsd, overdraftNanoUsd, planCount, loading }) {
  const inOverdraft = overdraftNanoUsd > 0;

  return (
    <section className="flex flex-col border border-border bg-surface">
      <div className="flex flex-wrap items-end justify-between gap-6 p-6">
        <div className="flex flex-col gap-2">
          <span className="meta text-text-muted">Available balance</span>
          {loading ? (
            <span className="block h-[46px] w-56 bg-surface-2" aria-hidden="true" />
          ) : (
            <span className="font-mono text-[40px] leading-none font-semibold tracking-tight text-text-main">
              {fmtUsdNano(availableNanoUsd)}
            </span>
          )}
          <span className="text-[11px] text-text-muted">
            Spends against active plans only. Expired credit is not counted.
          </span>
        </div>

        <dl className="flex items-stretch border border-border divide-x divide-border">
          <div className="px-4 py-3 min-w-[120px]">
            <dt className="meta text-text-subtle">Plans</dt>
            <dd className="font-mono text-sm text-text-main mt-1">{loading ? "—" : planCount}</dd>
          </div>
          <div className="px-4 py-3 min-w-[120px]">
            <dt className="meta text-text-subtle">Overdraft</dt>
            <dd
              className={`font-mono text-sm mt-1 ${
                inOverdraft ? "text-danger" : "text-text-main"
              }`}
            >
              {loading ? "—" : fmtUsdNano(overdraftNanoUsd)}
            </dd>
          </div>
        </dl>
      </div>

      {inOverdraft && !loading && (
        <div className="flex items-start gap-3 border-t border-danger/40 bg-danger/5 px-6 py-4">
          <span className="material-symbols-outlined text-[20px] text-danger">warning</span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-danger">
              Your account is {fmtUsdNano(overdraftNanoUsd)} in overdraft
            </p>
            <p className="text-[11px] text-text-muted">
              Requests are blocked while the balance is at or below zero. Buying a plan repays the
              overdraft first, and only the remainder becomes spendable credit.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
