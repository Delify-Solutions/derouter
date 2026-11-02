"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmtUsd } from "@/shared/utils/money";
import { cn } from "@/shared/utils/cn";
import { fitFigureStyle } from "@/shared/utils/fitFigure";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
// Costs arrive from /api/usage/stats as legacy USD floats; fmtUsd applies the
// shared adaptive precision (2dp >= $1, 4dp >= $0.01, else 6dp).
const fmtCost = (n) => fmtUsd(n || 0);

// The figure scales down with its tile (a size container) instead of being cut
// off with an ellipsis: "4,103,705,034" stays readable in a 5-column row.
function OverviewCard({ label, value, tone, note }) {
  return (
    <Card className="@container flex min-w-0 flex-col gap-1 px-4 py-3">
      <span className="text-text-muted text-sm uppercase font-semibold">{label}</span>
      <span
        className={cn("text-2xl font-bold tabular-nums leading-tight [overflow-wrap:anywhere]", tone)}
        style={fitFigureStyle(value, { maxRem: 1.5, minRem: 0.875 })}
      >
        {value}
      </span>
      {note ? <span className="text-[10px] text-text-muted">{note}</span> : null}
    </Card>
  );
}

OverviewCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  tone: PropTypes.string,
  note: PropTypes.string,
};

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 sm:gap-4">
      <OverviewCard label="Total Requests" value={fmt(stats.totalRequests)} />
      <OverviewCard label="Total Input Tokens" value={fmt(stats.totalPromptTokens)} tone="text-primary" />
      <OverviewCard label="Cached Tokens" value={fmt(stats.totalCachedTokens)} tone="text-info" />
      <OverviewCard label="Output Tokens" value={fmt(stats.totalCompletionTokens)} tone="text-success" />
      <OverviewCard
        label="Est. Cost"
        value={`~${fmtCost(stats.totalCost)}`}
        tone="text-warning"
        note="Estimated, not actual billing"
      />
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
