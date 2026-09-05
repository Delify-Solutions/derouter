export interface StatusFilterOption {
  value: string;
  label: string;
}

export const STATUS_FILTER_OPTIONS: StatusFilterOption[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
];

export interface ProviderStats {
  connected: number;
  error: number;
  total: number;
  errorCode: string | null;
  errorTime: string | null;
  allDisabled: boolean;
}

// noAuth providers (e.g. free proxies) are always usable even though they
// never have a stored connection record, so they never fall into "none".
export function getConnectionStatus(
  stats: ProviderStats | null | undefined,
  isNoAuth = false,
): string {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(
  statusFilter: string,
  stats: ProviderStats | null | undefined,
  isNoAuth = false,
): boolean {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}
