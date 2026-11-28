"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmtUsdNano } from "@/shared/utils/money";

// Admin-only profit/loss summary for the chosen period (spec admin-usage-views
// "Overview profit and loss summary"). Revenue is the same recorded cost the existing
// "Est. Cost" card already shows (usageHistory.costNanoUsd — the only charge-like figure
// the day-blob aggregation carries); vendor cost is the new admin-only snapshot
// (spec vendor-cost-pricing). NULL-aware throughout: a period with zero priced requests
// never renders a vendor cost or profit figure, only the explanatory note.
export default function OverviewProfitSummary({ stats }) {
  const totalRequests = stats.totalRequests || 0;
  const pricedRequests = stats.totalPricedRequests || 0;
  const revenueNano = stats.totalCostNanoUsd || 0;
  const vendorCostNano = stats.totalVendorCostNanoUsd || 0;
  const profitNano = revenueNano - vendorCostNano;

  const fullyPriced = totalRequests > 0 && pricedRequests >= totalRequests;
  const nothingPriced = pricedRequests === 0;

  return (
    <Card padding="sm" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-vx-text-muted uppercase">Lãi / lỗ (giá vốn)</h3>
      </div>
      {nothingPriced ? (
        <p className="text-sm text-vx-text-muted">Chưa có dữ liệu giá vốn cho kỳ này</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-vx-text-muted">Doanh thu</span>
              <span className="font-mono tabular-nums text-lg font-semibold">{fmtUsdNano(revenueNano)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-vx-text-muted">Giá vốn</span>
              <span className="font-mono tabular-nums text-lg font-semibold">{fmtUsdNano(vendorCostNano)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-vx-text-muted">Lợi nhuận</span>
              <span className={`font-mono tabular-nums text-lg font-semibold ${profitNano < 0 ? "text-vx-danger" : "text-vx-success"}`}>
                {fmtUsdNano(profitNano)}
              </span>
            </div>
          </div>
          {!fullyPriced && (
            <p className="flex items-center gap-1 text-xs text-vx-text-muted">
              <span className="material-symbols-outlined text-[14px]">info</span>
              Một số yêu cầu chưa có dữ liệu giá vốn
            </p>
          )}
        </>
      )}
    </Card>
  );
}

OverviewProfitSummary.propTypes = {
  stats: PropTypes.shape({
    totalRequests: PropTypes.number,
    totalPricedRequests: PropTypes.number,
    totalCostNanoUsd: PropTypes.number,
    totalVendorCostNanoUsd: PropTypes.number,
  }).isRequired,
};
