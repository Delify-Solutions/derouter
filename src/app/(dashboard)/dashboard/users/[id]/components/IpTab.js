"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "@/shared/components";
import { dateOf, timeOf } from "@/shared/components/billing";

// Spec activity-ip-log "Admin IP lookup": where an account has been, who else was
// there, and what it did. Banning is the existing status action on the overview.

const ACTION_LABEL = {
  register: "Đăng ký",
  login: "Đăng nhập",
  login_failed: "Sai mật khẩu",
  login_blocked: "Đăng nhập khi bị khóa",
  logout: "Đăng xuất",
  password_change: "Đổi mật khẩu",
  password_reset: "Đặt lại mật khẩu",
  email_verified: "Xác minh email",
  key_create: "Tạo API key",
  key_update: "Đổi gói của key",
  key_delete: "Xóa API key",
  key_reveal: "Xem API key",
  order_create: "Tạo đơn hàng",
  gift_redeem: "Nhập mã quà",
  gift_refused: "Nhập mã bị từ chối",
  plan_reorder: "Sắp xếp gói",
  telegram_link: "Liên kết Telegram",
  telegram_unlink: "Gỡ Telegram",
};

const STATUS_LABEL = { active: "Hoạt động", unverified: "Chưa xác minh", suspended: "Đang khóa", deleted: "Đã xóa" };

function when(iso) {
  return iso ? `${dateOf(iso)} ${timeOf(iso)}` : "—";
}

function detailText(action, details) {
  if (!details) return "";
  if (details.name) return details.name;
  if (details.code) return details.reason ? `${details.code} · ${details.reason}` : details.code;
  if (details.orderId) return `${details.method || ""} · ${String(details.orderId).slice(0, 8)}`;
  if (details.telegramUsername) return `@${details.telegramUsername}`;
  if (details.telegramUserId) return String(details.telegramUserId);
  if (details.status) return details.status;
  return "";
}

/** Accounts seen on one IP. */
function IpAccountsModal({ ip, onClose }) {
  const [state, setState] = useState({ loading: true, error: "", accounts: [] });

  useEffect(() => {
    if (!ip) return undefined;
    let cancelled = false;
    fetch(`/api/ip-lookup?ip=${encodeURIComponent(ip)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Không tra được IP");
        if (!cancelled) setState({ loading: false, error: "", accounts: body.accounts || [] });
      })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e.message, accounts: [] }); });
    return () => { cancelled = true; };
  }, [ip]);

  return (
    <Modal isOpen={Boolean(ip)} onClose={onClose} title={`Tài khoản dùng IP ${ip || ""}`} size="full">
      {state.loading ? (
        <p className="text-sm text-text-muted">Đang tải…</p>
      ) : state.error ? (
        <p role="alert" className="text-sm text-danger">{state.error}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            {state.accounts.length} tài khoản. Khóa tài khoản ở tab Tổng quan của từng người.
          </p>
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th scope="col" className="meta px-3 py-2 font-medium text-text-muted">Tài khoản</th>
                  <th scope="col" className="meta px-3 py-2 font-medium text-text-muted">Trạng thái</th>
                  <th scope="col" className="meta px-3 py-2 text-right font-medium text-text-muted">Web</th>
                  <th scope="col" className="meta px-3 py-2 text-right font-medium text-text-muted">API</th>
                  <th scope="col" className="meta px-3 py-2 font-medium text-text-muted">Gần nhất</th>
                </tr>
              </thead>
              <tbody>
                {state.accounts.map((account) => (
                  <tr key={account.userId} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2 text-sm">
                      {account.status === "deleted" ? (
                        <span className="font-mono text-[12px] text-text-muted">{account.userId}</span>
                      ) : (
                        <Link href={`/dashboard/users/${account.userId}?tab=ip`} className="text-text-main underline underline-offset-2 [overflow-wrap:anywhere]">
                          {account.email || account.userId}
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-text-muted">
                      {account.status === "suspended" ? (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">block</span>
                          {STATUS_LABEL.suspended}
                        </span>
                      ) : (
                        STATUS_LABEL[account.status] || account.status
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px] text-text-main">{account.webCount}</td>
                    <td className="px-3 py-2 text-right font-mono text-[12px] text-text-main">{account.apiCount}</td>
                    <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">{when(account.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** `IP` — IPs of the account, how many other accounts share each, and recent activity. */
export default function IpTab({ userId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [lookupIp, setLookupIp] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/users/${userId}/ips`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được IP");
      setData(body);
    } catch (e) {
      setError(e.message || "Không tải được IP");
    }
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/users/${userId}/ips`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Không tải được IP");
        if (!cancelled) setData(body);
      })
      .catch((e) => { if (!cancelled) setError(e.message || "Không tải được IP"); });
    return () => { cancelled = true; };
  }, [userId]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>
        <div><button type="button" onClick={load} className="text-sm underline">Thử lại</button></div>
      </div>
    );
  }
  if (!data) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  const ips = data.ips || [];
  const activity = data.activity || [];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">IP đã dùng</h3>
          <p className="text-[12px] text-text-muted">
            Từ thao tác trên web và request API bằng key của tài khoản ({data.lookbackDays} ngày gần nhất cho API).
            Bấm một IP để xem các tài khoản khác dùng chung.
          </p>
        </div>
        {ips.length === 0 ? (
          <div className="border border-border bg-surface px-6 py-8">
            <p className="text-sm text-text-muted">Chưa ghi nhận IP nào. IP được ghi từ bản cập nhật này trở đi.</p>
          </div>
        ) : (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">IP</th>
                  <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Web</th>
                  <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">API</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Lần đầu</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Gần nhất</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Tài khoản khác</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((row) => (
                  <tr key={row.ip} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setLookupIp(row.ip)}
                        className="font-mono text-[12px] text-text-main underline underline-offset-2 hover:text-brand-600"
                      >
                        {row.ip}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-text-main">{row.webCount}</td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-text-main">{row.apiCount}</td>
                    <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.firstSeen)}</td>
                    <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.lastSeen)}</td>
                    <td className="px-4 py-2 text-[12px]">
                      {row.otherAccounts > 0 ? (
                        <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">group</span>
                          <span className="font-mono">{row.otherAccounts}</span> tài khoản khác
                        </span>
                      ) : (
                        <span className="text-text-muted">Không</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Hoạt động gần đây</h3>
          <p className="text-[12px] text-text-muted">100 thao tác mới nhất trên web.</p>
        </div>
        {activity.length === 0 ? (
          <div className="border border-border bg-surface px-6 py-8">
            <p className="text-sm text-text-muted">Chưa có thao tác nào được ghi.</p>
          </div>
        ) : (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Thời gian</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Thao tác</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Chi tiết</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">IP</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Thiết bị</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.createdAt)}</td>
                    <td className="px-4 py-2 text-sm text-text-main whitespace-nowrap">{ACTION_LABEL[row.action] || row.action}</td>
                    <td className="max-w-[220px] truncate px-4 py-2 font-mono text-[11px] text-text-muted" title={detailText(row.action, row.details)}>
                      {detailText(row.action, row.details) || "—"}
                    </td>
                    <td className="px-4 py-2">
                      {row.ip ? (
                        <button
                          type="button"
                          onClick={() => setLookupIp(row.ip)}
                          className="font-mono text-[12px] text-text-main underline underline-offset-2 hover:text-brand-600"
                        >
                          {row.ip}
                        </button>
                      ) : (
                        <span className="font-mono text-[12px] text-text-muted">—</span>
                      )}
                    </td>
                    <td className="max-w-[260px] truncate px-4 py-2 font-mono text-[11px] text-text-muted" title={row.userAgent || ""}>
                      {row.userAgent || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <IpAccountsModal ip={lookupIp} onClose={() => setLookupIp(null)} />
    </div>
  );
}
