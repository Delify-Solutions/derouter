"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Modal, Table } from "@/shared/components";
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
          <Table className="min-w-[560px] text-left">
            <Table.Head>
              <tr>
                <Table.HeaderCell>Tài khoản</Table.HeaderCell>
                <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Web</Table.HeaderCell>
                <Table.HeaderCell className="text-right">API</Table.HeaderCell>
                <Table.HeaderCell>Gần nhất</Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {state.accounts.map((account) => (
                <Table.Row key={account.userId}>
                  <Table.Cell className="text-sm">
                    {account.status === "deleted" ? (
                      <span className="font-mono text-[12px] text-text-muted">{account.userId}</span>
                    ) : (
                      <Link href={`/dashboard/users/${account.userId}?tab=ip`} className="text-text-main underline underline-offset-2 [overflow-wrap:anywhere]">
                        {account.email || account.userId}
                      </Link>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-[12px] text-text-muted">
                    {account.status === "suspended" ? (
                      <span className="inline-flex items-center gap-1 text-danger">
                        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">block</span>
                        {STATUS_LABEL.suspended}
                      </span>
                    ) : (
                      STATUS_LABEL[account.status] || account.status
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-right font-mono text-[12px] text-text-main">{account.webCount}</Table.Cell>
                  <Table.Cell className="text-right font-mono text-[12px] text-text-main">{account.apiCount}</Table.Cell>
                  <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">{when(account.lastSeen)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
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
        <div><Button variant="ghost" size="sm" onClick={load}>Thử lại</Button></div>
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
          <Card padding="sm">
            <p className="text-sm text-text-muted">Chưa ghi nhận IP nào. IP được ghi từ bản cập nhật này trở đi.</p>
          </Card>
        ) : (
          <Table className="min-w-[720px] text-left">
            <Table.Head>
              <tr>
                <Table.HeaderCell>IP</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Web</Table.HeaderCell>
                <Table.HeaderCell className="text-right">API</Table.HeaderCell>
                <Table.HeaderCell>Lần đầu</Table.HeaderCell>
                <Table.HeaderCell>Gần nhất</Table.HeaderCell>
                <Table.HeaderCell>Tài khoản khác</Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {ips.map((row) => (
                <Table.Row key={row.ip}>
                  <Table.Cell>
                    <button
                      type="button"
                      onClick={() => setLookupIp(row.ip)}
                      className="font-mono text-[12px] text-text-main underline underline-offset-2 hover:text-brand-600"
                    >
                      {row.ip}
                    </button>
                  </Table.Cell>
                  <Table.Cell className="text-right font-mono text-[12px] text-text-main">{row.webCount}</Table.Cell>
                  <Table.Cell className="text-right font-mono text-[12px] text-text-main">{row.apiCount}</Table.Cell>
                  <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.firstSeen)}</Table.Cell>
                  <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.lastSeen)}</Table.Cell>
                  <Table.Cell className="text-[12px]">
                    {row.otherAccounts > 0 ? (
                      <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">group</span>
                        <span className="font-mono">{row.otherAccounts}</span> tài khoản khác
                      </span>
                    ) : (
                      <span className="text-text-muted">Không</span>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Hoạt động gần đây</h3>
          <p className="text-[12px] text-text-muted">100 thao tác mới nhất trên web.</p>
        </div>
        {activity.length === 0 ? (
          <Card padding="sm">
            <p className="text-sm text-text-muted">Chưa có thao tác nào được ghi.</p>
          </Card>
        ) : (
          <Table className="min-w-[760px] text-left">
            <Table.Head>
              <tr>
                <Table.HeaderCell>Thời gian</Table.HeaderCell>
                <Table.HeaderCell>Thao tác</Table.HeaderCell>
                <Table.HeaderCell>Chi tiết</Table.HeaderCell>
                <Table.HeaderCell>IP</Table.HeaderCell>
                <Table.HeaderCell>Thiết bị</Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {activity.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">{when(row.createdAt)}</Table.Cell>
                  <Table.Cell className="text-sm text-text-main whitespace-nowrap">{ACTION_LABEL[row.action] || row.action}</Table.Cell>
                  <Table.Cell className="max-w-[220px] truncate font-mono text-[11px] text-text-muted" title={detailText(row.action, row.details)}>
                    {detailText(row.action, row.details) || "—"}
                  </Table.Cell>
                  <Table.Cell>
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
                  </Table.Cell>
                  <Table.Cell className="max-w-[260px] truncate font-mono text-[11px] text-text-muted" title={row.userAgent || ""}>
                    {row.userAgent || "—"}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </section>

      <IpAccountsModal ip={lookupIp} onClose={() => setLookupIp(null)} />
    </div>
  );
}
