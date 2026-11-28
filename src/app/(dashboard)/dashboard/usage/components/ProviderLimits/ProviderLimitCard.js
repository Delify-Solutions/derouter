"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import QuotaProgressBar from "./QuotaProgressBar";
import { calculatePercentage } from "./utils";

const planVariants = {
  free: "default",
  pro: "primary",
  ultra: "success",
  enterprise: "info",
};

export default function ProviderLimitCard({
  provider,
  name,
  plan,
  quotas = [],
  message = null,
  loading = false,
  error = null,
  onRefresh,
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;

    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Get provider info from config
  const getProviderColor = () => {
    const colors = {
      github: "#000000",
      antigravity: "#4285F4",
      codex: "#10A37F",
      kiro: "#FF9900",
      qoder: "#EC4899",
      claude: "#D97757",
    };
    return colors[provider?.toLowerCase()] || "#6B7280";
  };

  const providerColor = getProviderColor();
  const planVariant = planVariants[plan?.toLowerCase()] || "default";

  return (
    <Card padding="md" className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Provider Logo */}
          <div
            className="size-10 rounded-lg flex items-center justify-center p-1.5"
            style={{ backgroundColor: `${providerColor}15` }}
          >
            <ProviderIcon
              src={`/providers/${provider}.png`}
              alt={provider || "Provider"}
              size={40}
              className="object-contain rounded-lg"
              fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
              fallbackColor={providerColor}
            />
          </div>

          <div>
            <h3 className="font-semibold text-vx-text">
              {name || provider}
            </h3>
            {plan && (
              <Badge variant={planVariant} size="xs">
                {plan}
              </Badge>
            )}
          </div>
        </div>

        {/* Refresh Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          title="Refresh quota"
          aria-label="Refresh quota"
          className="!h-9 !w-9 !p-0 text-vx-text-muted"
        >
          <span
            className={`material-symbols-outlined text-[20px] ${refreshing || loading ? "animate-spin" : ""}`}
          >
            refresh
          </span>
        </Button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="h-4 bg-vx-surface-3 rounded-vx-xs animate-pulse" />
            <div className="h-2 bg-vx-surface-3 rounded-vx-xs animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-vx-surface-3 rounded-vx-xs animate-pulse" />
            <div className="h-2 bg-vx-surface-3 rounded-vx-xs animate-pulse" />
          </div>
        </div>
      )}

      {/* Error State */}
      {!loading && error && (
        <div className="p-4 rounded-vx-md bg-vx-danger/10 border border-vx-danger/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-vx-danger text-[20px]">
              error
            </span>
            <p className="text-sm text-vx-danger">{error}</p>
          </div>
        </div>
      )}

      {/* Info Message (for providers without API) */}
      {!loading && !error && message && (
        <div className="p-4 rounded-vx-md bg-vx-info/10 border border-vx-info/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-vx-info text-[20px]">
              info
            </span>
            <p className="text-sm text-vx-info">
              {message}
            </p>
          </div>
        </div>
      )}

      {/* Quota Progress Bars */}
      {!loading && !error && !message && quotas?.length > 0 && (
        <div className="space-y-4">
          {quotas.map((quota, index) => {
            // For Antigravity, use remainingPercentage if available, otherwise calculate
            const percentage =
              quota.remainingPercentage !== undefined
                ? Math.round(((quota.total - quota.used) / quota.total) * 100)
                : calculatePercentage(quota.used, quota.total);
            const unlimited = quota.total === 0 || quota.total === null;

            return (
              <QuotaProgressBar
                key={`${quota.name}-${index}`}
                label={quota.name}
                used={quota.used}
                total={quota.total}
                percentage={percentage}
                unlimited={unlimited}
                resetTime={quota.resetAt}
                recurring={quota.recurring !== false}
              />
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && !message && quotas?.length === 0 && (
        <div className="text-center py-8 text-vx-text-muted">
          <span className="material-symbols-outlined text-[48px] opacity-20">
            data_usage
          </span>
          <p className="text-sm mt-2">No quota data available</p>
        </div>
      )}
    </Card>
  );
}
