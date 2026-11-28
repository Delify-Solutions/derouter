"use client";

import { useEffect, useMemo, useState } from "react";
import Table from "@/shared/components/Table";
import Button from "@/shared/components/Button";
import { formatResetTime, getRemainingPercentage } from "./utils";

const PAGE_SIZE = 10;

/**
 * Format reset time display (Today, 12:00 PM)
 */
function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;

  try {
    const date = new Date(resetTime);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dayStr = "";
    if (date >= today && date < tomorrow) {
      dayStr = "Today";
    } else if (date >= tomorrow && date < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      dayStr = "Tomorrow";
    } else {
      dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

/**
 * Get color classes based on remaining percentage
 */
function getColorClasses(remainingPercentage) {
  if (remainingPercentage > 70) {
    return {
      text: "text-vx-success",
      bg: "bg-vx-success",
      bgLight: "bg-vx-success/10",
      emoji: "🟢",
    };
  }

  if (remainingPercentage >= 30) {
    return {
      text: "text-vx-warning",
      bg: "bg-vx-warning",
      bgLight: "bg-vx-warning/10",
      emoji: "🟡",
    };
  }

  return {
    text: "text-vx-danger",
    bg: "bg-vx-danger",
    bgLight: "bg-vx-danger/10",
    emoji: "🔴",
  };
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name));
  }

  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }

  return quotas;
}

/**
 * Quota Table Component - Table-based display for quota data
 */
export default function QuotaTable({
  quotas = [],
  compact = false,
  sortMode = "default",
  showSortLabel = false,
  onHideQuota = null,
}) {
  const [page, setPage] = useState(1);

  const normalizedQuotas = useMemo(
    () => quotas.map((quota, index) => ({
      ...quota,
      index,
      remaining: getRemainingPercentage(quota),
    })),
    [quotas],
  );

  const sortedQuotas = useMemo(
    () => sortQuotas(normalizedQuotas, sortMode),
    [normalizedQuotas, sortMode],
  );

  const totalPages = Math.max(1, Math.ceil(sortedQuotas.length / PAGE_SIZE));

  useEffect(() => {
    setPage(1);
  }, [sortMode, quotas]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  if (!quotas || quotas.length === 0) {
    return null;
  }

  const currentPageRows = sortedQuotas.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
  const pageStart = sortedQuotas.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, sortedQuotas.length);

  const cellPad = compact ? "py-1 px-1.5" : "py-2 px-3";
  const nameText = compact ? "text-[11px]" : "text-sm";
  const resetPrimary = compact ? "text-[11px]" : "text-sm";
  const resetSecondary = compact ? "text-[10px] leading-tight" : "text-xs";
  const sortLabel = "Sorted by account remaining";
  const hasHideAction = typeof onHideQuota === "function";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-vx-text-muted">
          {sortedQuotas.length} quota{sortedQuotas.length > 1 ? "s" : ""}
        </div>
        {showSortLabel && (
          <div className="rounded-vx-sm border border-vx-border bg-vx-surface-2 px-2 py-1 text-[10px] text-vx-text-muted">
            {sortLabel}
          </div>
        )}
      </div>

      <Table bare className="table-fixed">
        <Table.Body>
          {currentPageRows.map((quota) => {
            const isUnlimited = quota.unlimited === true;
            const colors = getColorClasses(quota.remaining);
            const countdown = formatResetTime(quota.resetAt);
            const resetDisplay = formatResetTimeDisplay(quota.resetAt);
            // recurring defaults true: a missing flag means the quota
            // refreshes at resetAt. Bonus/one-shot packs set recurring:false
            // and their resetAt is a hard expiry, so word it as "expires".
            const recurring = quota.recurring !== false;
            const countdownLabel = recurring ? `in ${countdown}` : `expires in ${countdown}`;

            return (
              <Table.Row key={`${quota.name}-${quota.index}`}>
                {/* Name */}
                <Table.Cell className={`w-36 ${cellPad}`}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-[10px] shrink-0">{colors.emoji}</span>
                    <span className={`${nameText} font-medium text-vx-text truncate`}>
                      {quota.name}
                    </span>
                  </div>
                </Table.Cell>

                {/* Progress + used/total */}
                <Table.Cell className={`min-w-0 ${cellPad}`}>
                  <div className={`min-w-0 ${compact ? "space-y-1" : "space-y-1.5"}`}>
                    {!isUnlimited && (
                    <div className={`${compact ? "h-1" : "h-1.5"} rounded-full overflow-hidden border ${colors.bgLight} ${
                      quota.remaining === 0 ? "border-vx-border" : "border-transparent"
                    }`}>
                      <div
                        className={`h-full transition-all duration-300 ${colors.bg}`}
                        style={{ width: `${Math.min(quota.remaining, 100)}%` }}
                      />
                    </div>
                    )}

                    <div className={`flex items-center justify-between gap-1 min-w-0 ${compact ? "text-[10px]" : "text-xs"}`}>
                      <span
                        className="text-vx-text-muted truncate"
                        title={
                          isUnlimited
                            ? `${quota.used.toLocaleString()} used · Unlimited`
                            : `${quota.used.toLocaleString()} / ${quota.total > 0 ? quota.total.toLocaleString() : "∞"}`
                        }
                      >
                        {isUnlimited
                          ? `${quota.used.toLocaleString()} used · Unlimited`
                          : `${quota.used.toLocaleString()} / ${quota.total > 0 ? quota.total.toLocaleString() : "∞"}`}
                      </span>
                      <span className={`font-medium ${isUnlimited ? "text-vx-success" : colors.text} shrink-0`}>
                        {isUnlimited ? "Unlimited" : `${quota.remaining}%`}
                      </span>
                    </div>
                  </div>
                </Table.Cell>

                {/* Reset time */}
                <Table.Cell className={`min-w-0 w-28 shrink ${cellPad}`}>
                  {countdown !== "-" || resetDisplay ? (
                    compact ? (
                      <div
                        className={`${resetPrimary} text-vx-text font-medium truncate`}
                        title={resetDisplay || ""}
                      >
                        {countdown !== "-" ? countdownLabel : resetDisplay}
                      </div>
                    ) : (
                      <div className="min-w-0 space-y-0.5">
                        {countdown !== "-" && (
                          <div className={`${resetPrimary} text-vx-text font-medium truncate`}>
                            {countdownLabel}
                          </div>
                        )}
                        {resetDisplay && (
                          <div className={`${resetSecondary} text-vx-text-muted truncate`}>
                            {resetDisplay}
                          </div>
                        )}
                      </div>
                    )
                  ) : (
                    <div className={`${resetPrimary} text-vx-text-muted italic`}>N/A</div>
                  )}
                </Table.Cell>

                {/* Hide action */}
                {hasHideAction && (
                  <Table.Cell className={`w-8 ${cellPad}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="visibility_off"
                      onClick={() => onHideQuota(quota)}
                      title="Hide this quota row"
                      aria-label={`Hide quota ${quota.name}`}
                      className="!h-6 !w-6 shrink-0 !p-0"
                    />
                  </Table.Cell>
                )}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>

      {totalPages > 1 && (
        <div className="rounded-vx-sm border border-vx-border bg-vx-surface-2 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-vx-text-muted">
            <span>
              Showing {pageStart}-{pageEnd} of {sortedQuotas.length}
            </span>
            <span>
              Page {page} / {totalPages}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <Button
              variant="light-outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page === 1}
              className="!h-6 !px-2 !text-[10px]"
            >
              Prev
            </Button>
            <Button
              variant="light-outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page === totalPages}
              className="!h-6 !px-2 !text-[10px]"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
