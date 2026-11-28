"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

// `key` matches a page key in src/lib/auth/adminPages.js — the single registry
// that also drives dashboardGuard.js's and every API route's permission check
// (spec admin-accounts "The sidebar SHALL show only the pages the signed-in
// account can view"). Kept as plain strings here (not imported) so this stays a
// client component with no server-only module in its graph.
const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api", key: "endpoint" },
  // Người dùng là thực thể trung tâm của mô hình multi-tenant: không có lối vào
  // này thì admin không thể đổi nhóm, khóa hay xem ai đang dùng bao nhiêu.
  { href: "/dashboard/users", label: "Người dùng", icon: "person", key: "users" },
  { href: "/dashboard/groups", label: "Groups", icon: "group_work", key: "groups" },
  { href: "/dashboard/pricing", label: "Pricing", icon: "sell", key: "pricing" },
  { href: "/dashboard/plans", label: "Plans", icon: "sell", key: "plans" },
  { href: "/dashboard/orders", label: "Orders", icon: "receipt_long", key: "orders" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns", key: "providers" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat", key: "basic-chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers", key: "combos" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart", key: "usage" },
  { href: "/dashboard/cache-refunds", label: "Hoàn tiền cache", icon: "cached", key: "cache-refunds" },
  // Token statistics by time, model, provider and customer (change usage-analytics).
  { href: "/dashboard/stats", label: "Thống kê", icon: "query_stats", key: "stats" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage", key: "quota" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings", key: "token-saver" },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image", key: "pxpipe" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal", key: "cli-tools" },
  { href: "/dashboard/gift-codes", label: "Gift codes", icon: "redeem", key: "gift-codes" },
  // Affiliate program: settings, CTVs, commissions and vouchers (spec
  // affiliate-program "Admin affiliate management").
  { href: "/dashboard/affiliates", label: "Affiliate", icon: "group_add", key: "affiliates" },
  // Payment accounts + received transactions. The needs-review badge is the
  // reason this item exists in the sidebar rather than buried in settings.
  { href: "/dashboard/payments", label: "Thanh toán", icon: "account_balance", badge: "needsReview", key: "payments" },
  { href: "/dashboard/content", label: "Nội dung", icon: "article", key: "content" },
  { href: "/dashboard/announcements", label: "Thông báo", icon: "notifications", key: "announcements" },
  // The system image storage and every customer's (spec image-storage).
  { href: "/dashboard/storage", label: "CDN ảnh", icon: "cloud_upload", key: "storage" },
  { href: "/dashboard/telegram", label: "Telegram", icon: "campaign", key: "telegram" },
  { href: "/dashboard/admin-accounts", label: "Tài khoản Admin", icon: "admin_panel_settings", key: "admin-accounts" },
];

const debugItems = [
  { href: "/dashboard/errors", label: "Nhật ký lỗi", icon: "error", key: "errors" },
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal", key: "console-log" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate", key: "translator" },
];

const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan", key: "proxy-pools" },
  // Skills the operator publishes for customers to download (change customer-skills).
  { href: "/dashboard/customer-skills", label: "Skill khách hàng", icon: "download", key: "customer-skills" },
  // DSH plugins: npm packages a customer adds to their harness profile. Different
  // install path from a skill, so a different page (change dsh-plugins).
  { href: "/dashboard/dsh-plugins", label: "Plugin DSH", icon: "widgets", key: "dsh-plugins" },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  // How many received transactions are waiting for an admin decision. Refreshed
  // with the rest of the shell so a new needs-review row shows up without a reload.
  const [needsReview, setNeedsReview] = useState(0);
  // Pages the signed-in account may view (spec admin-accounts). null = not loaded
  // yet: every item stays visible for that first paint rather than flashing
  // empty, since the dashboardGuard page-level check is the authoritative gate —
  // this list is only a nicety so a scoped account never sees a dead link.
  const [viewablePages, setViewablePages] = useState(null);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;
  const canView = (key) => !key || viewablePages === null || viewablePages.includes(key);

  useEffect(() => {
    fetch("/api/settings")
      .then(res => res.json())
      .then(data => { if (data.enableTranslator) setEnableTranslator(true); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => {
        if (data.isSuperAdmin) setViewablePages(null); // null keeps every item visible
        else setViewablePages(Array.isArray(data.viewablePages) ? data.viewablePages : []);
      })
      .catch(() => {});
  }, []);

  // Needs-review badge. 60 s is the admin's "no longer fresh" horizon: a payment
  // sits in review until someone acts, so a faster poll would only add requests.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/payments/transactions?status=needs_review&page=1", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data && typeof data.needsReviewCount === "number") {
            setNeedsReview(data.needsReviewCount);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Lazy check for new npm version on mount
  useEffect(() => {
    fetch("/api/version")
      .then(res => res.json())
      .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
      .catch(() => {});
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.


  return (
    <>
      <aside className="flex w-vx-menu flex-col bg-vx-surface shadow-vx-xs transition-colors duration-300 min-h-full">
        {/* Logo */}
        <div className="px-6 py-5 flex flex-col gap-2 border-b border-vx-border">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex items-center justify-center size-9 rounded-vx-md bg-vx-primary">
              <span className="material-symbols-outlined text-white text-[20px]">hub</span>
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold tracking-tight text-vx-heading">
                {APP_CONFIG.name}
              </h1>
              <span className="text-[11px] text-vx-text-muted">v{APP_CONFIG.version}</span>
            </div>
          </Link>
          {updateInfo && (
            <div className="flex flex-col gap-1.5 rounded-vx-md bg-vx-primary/10 p-2">
              <span className="text-xs font-medium text-vx-primary">
                New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="px-2 h-7 rounded-vx-sm bg-vx-primary hover:bg-vx-primary-hover text-white text-[11px] font-medium transition-colors cursor-pointer"
                >
                  Update now
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                >
                  <code className="block text-[10px] text-vx-text-muted font-mono truncate">
                    {copied ? "✓ copied!" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          {navItems.filter((item) => canView(item.key)).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 h-10 rounded-vx-md text-sm font-medium transition-colors group",
                isActive(item.href)
                  ? "bg-vx-primary/12 text-vx-primary"
                  : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive(item.href) ? "fill-1" : "group-hover:text-vx-text transition-colors"
                )}
              >
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {/* Never colour alone: the count is the signal, the tint only
                  reinforces it (ui-dna §4). */}
              {item.badge === "needsReview" && needsReview > 0 && (
                <span
                  className="min-w-5 rounded-vx-pill bg-vx-danger/15 px-1.5 text-center text-[10px] font-semibold leading-5 text-vx-danger"
                  aria-label={`${needsReview} giao dịch cần kiểm tra`}
                >
                  {needsReview > 99 ? "99+" : needsReview}
                </span>
              )}
            </Link>
          ))}

          {/* System section */}
          <div className="pt-3 mt-2 space-y-0.5">
            <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wide text-vx-text-subtle">System</p>

            {/* Media Providers accordion */}
            {canView("media-providers") && (
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex items-center gap-3 px-3 h-10 rounded-vx-md text-sm font-medium transition-colors group",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-vx-primary/12 text-vx-primary"
                  : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="flex-1 text-left">Media Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            )}
            {canView("media-providers") && mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 pl-11 pr-3 h-9 rounded-vx-md transition-colors group text-sm font-medium",
                      pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                        ? "bg-vx-primary/12 text-vx-primary"
                        : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span>{kind.label}</span>
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 pl-11 pr-3 h-9 rounded-vx-md transition-colors group text-sm font-medium",
                    pathname.startsWith(COMBINED_WEB_ITEM.href)
                      ? "bg-vx-primary/12 text-vx-primary"
                      : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                  <span>{COMBINED_WEB_ITEM.label}</span>
                </Link>
              </div>
            )}

            {systemItems.filter((item) => canView(item.key)).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 px-3 h-10 rounded-vx-md text-sm font-medium transition-colors group",
                  isActive(item.href)
                    ? "bg-vx-primary/12 text-vx-primary"
                    : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
                )}
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px]",
                    isActive(item.href) ? "fill-1" : "group-hover:text-vx-text transition-colors"
                  )}
                >
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            ))}

            {/* Debug items (inside System section, before Settings) */}
            {debugItems.map((item) => {
              const show = (item.href !== "/dashboard/translator" || enableTranslator) && canView(item.key);
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-3 h-10 rounded-vx-md text-sm font-medium transition-colors group",
                    isActive(item.href)
                      ? "bg-vx-primary/12 text-vx-primary"
                      : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) ? "fill-1" : "group-hover:text-vx-text transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              ) : null;
            })}

            {/* Settings */}
            <Link
              href="/dashboard/profile"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 h-10 rounded-vx-md text-sm font-medium transition-colors group",
                isActive("/dashboard/profile")
                  ? "bg-vx-primary/12 text-vx-primary"
                  : "text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-text"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-vx-text transition-colors"
                )}
              >
                settings
              </span>
              <span>Settings</span>
            </Link>
          </div>
        </nav>

      </aside>

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update derouter"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-vx-2xl bg-red-500/10 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-white/70 mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-vx-lg shadow-vx-xl bg-neutral-900/95 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-vx-md bg-amber-500/10 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update derouter{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded-vx-md bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded-vx-sm bg-white/10 text-green-400">derouter</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
