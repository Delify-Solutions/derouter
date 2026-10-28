"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmtUsd } from "@/shared/utils/money";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
// Costs arrive from /api/usage/stats as legacy USD floats; fmtUsd applies the
// shared adaptive precision (2dp >= $1, 4dp >= $0.01, else 6dp).
const fmtCost = (n) => fmtUsd(n || 0);

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
        <span className="truncate text-2xl font-bold">{fmt(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
        <span className="truncate text-2xl font-bold text-primary">{fmt(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
        <span className="truncate text-2xl font-bold text-info">{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
        <span className="truncate text-2xl font-bold text-success">{fmt(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
