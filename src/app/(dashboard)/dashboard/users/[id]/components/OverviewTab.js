"use client";

import { useEffect, useState } from "react";
import { Button, Input, Select } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";
import ReasonModal from "./ReasonModal";

const STATUS_OPTIONS = [
  { value: "active", label: "Hoạt động" },
  { value: "unverified", label: "Chưa xác minh" },
  { value: "suspended", label: "Khóa" },
];

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="meta text-text-muted">{label}</dt>
      <dd className="text-sm text-text-main">{children}</dd>
    </div>
  );
}

/**
 * `Tổng quan` — the account at a glance plus the four edits that live on it.
 *
 * Group, status and password go through the reason modal because they change what
 * the customer can do; the internal note does not, because it cannot.
 */
export default function OverviewTab({ user, summary, onChanged }) {
  const [groups, setGroups] = useState([]);
  const [action, setAction] = useState(null);
  const [draft, setDraft] = useState({ groupId: "", status: "", email: "", displayName: "", password: "", adminNote: "" });
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!user) return;
    setDraft({
      groupId: user.groupId || "",
      status: user.status || "active",
      email: user.email || "",
      displayName: user.displayName || "",
      password: "",
      adminNote: user.adminNote || "",
    });
  }, [user]);

  useEffect(() => {
    fetch("/api/groups", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { groups: [] }))
      .then((body) => setGroups((body.groups || []).filter((group) => group.isActive !== false)))
      .catch(() => setGroups([]));
  }, []);

  const patch = async (body) => {
    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "Không cập nhật được" };
    await onChanged();
    return { ok: true };
  };

  const saveNote = async () => {
    setNoteSaving(true);
    setNoteError("");
    const result = await patch({ adminNote: draft.adminNote });
    setNoteSaving(false);
    if (!result.ok) setNoteError(result.error);
    else setNotice("Đã lưu ghi chú");
  };

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <p role="status" className="border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">
          {notice}
        </p>
      )}

      <section className="border border-border bg-surface">
        <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-surface px-5 py-4"><Field label="Credit khả dụng">{fmtUsdNano(summary?.availableNanoUsd ?? 0)}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Đang nợ">{fmtUsdNano(summary?.debtNanoUsd ?? 0)}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Chi 7 ngày">{fmtUsdNano(summary?.spend7dNanoUsd ?? 0)}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Chi 30 ngày">{fmtUsdNano(summary?.spend30dNanoUsd ?? 0)}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="API key">{summary?.keyCount ?? 0}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Phiên mở">{summary?.sessionCount ?? 0}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Nhóm">{user.groupName || "—"}</Field></div>
          <div className="bg-surface px-5 py-4"><Field label="Trạng thái">{user.status}</Field></div>
        </dl>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3 border border-border bg-surface p-5">
          <h2 className="meta text-text-muted">Nhóm</h2>
          <p className="text-xs text-text-muted">Nhóm quyết định credit và model khách gọi được. Đổi nhóm có hiệu lực từ request kế tiếp.</p>
          <Select
            value={draft.groupId}
            onChange={(event) => setDraft((d) => ({ ...d, groupId: event.target.value }))}
            options={groups.map((group) => ({ value: group.id, label: group.name }))}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!draft.groupId || draft.groupId === user.groupId}
            onClick={() => setAction("group")}
          >
            Đổi nhóm
          </Button>
        </div>

        <div className="flex flex-col gap-3 border border-border bg-surface p-5">
          <h2 className="meta text-text-muted">Trạng thái</h2>
          <p className="text-xs text-text-muted">Khóa hoặc chưa xác minh sẽ hủy mọi phiên và chặn API ngay lập tức.</p>
          <Select
            value={draft.status}
            onChange={(event) => setDraft((d) => ({ ...d, status: event.target.value }))}
            options={STATUS_OPTIONS}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={draft.status === user.status}
            onClick={() => setAction("status")}
          >
            Đổi trạng thái
          </Button>
        </div>

        <div className="flex flex-col gap-3 border border-border bg-surface p-5">
          <h2 className="meta text-text-muted">Hồ sơ</h2>
          <Input label="Email" value={draft.email} onChange={(event) => setDraft((d) => ({ ...d, email: event.target.value }))} />
          <Input
            label="Tên hiển thị"
            value={draft.displayName}
            onChange={(event) => setDraft((d) => ({ ...d, displayName: event.target.value }))}
            placeholder="Không bắt buộc"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={(draft.email === user.email && draft.displayName === (user.displayName || "")) || !draft.email}
            onClick={() => setAction("profile")}
          >
            Lưu hồ sơ
          </Button>
        </div>

        <div className="flex flex-col gap-3 border border-border bg-surface p-5">
          <h2 className="meta text-text-muted">Mật khẩu</h2>
          <Input
            label="Mật khẩu mới"
            type="password"
            value={draft.password}
            onChange={(event) => setDraft((d) => ({ ...d, password: event.target.value }))}
            hint="10–200 ký tự. Đặt lại sẽ hủy mọi phiên đăng nhập."
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={draft.password.length < 10 || draft.password.length > 200}
            onClick={() => setAction("password")}
          >
            Đặt lại mật khẩu
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3 border border-border bg-surface p-5">
        <h2 className="meta text-text-muted">Ghi chú nội bộ</h2>
        <p className="text-xs text-text-muted">
          Chỉ admin thấy. Không cần lý do: nội dung này không thay đổi gì với khách.
        </p>
        <textarea
          value={draft.adminNote}
          onChange={(event) => setDraft((d) => ({ ...d, adminNote: event.target.value }))}
          rows={4}
          maxLength={2000}
          className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-brand-500 focus:outline-none"
          placeholder="Ví dụ: khách hẹn chuyển khoản thứ Sáu"
        />
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={saveNote} loading={noteSaving} disabled={draft.adminNote === (user.adminNote || "")}>
            Lưu ghi chú
          </Button>
          {noteError && <span className="text-[11px] text-danger">{noteError}</span>}
        </div>
      </section>

      <ReasonModal
        isOpen={action === "group"}
        title="Đổi nhóm"
        description={`Nhóm mới: ${groups.find((g) => g.id === draft.groupId)?.name || "—"}`}
        confirmLabel="Đổi nhóm"
        onClose={() => setAction(null)}
        values={{ groupId: draft.groupId }}
        onConfirm={async ({ reason, groupId }) => patch({ groupId, reason })}
      />

      <ReasonModal
        isOpen={action === "status"}
        title="Đổi trạng thái"
        description={`Trạng thái mới: ${STATUS_OPTIONS.find((s) => s.value === draft.status)?.label || draft.status}`}
        confirmLabel="Đổi trạng thái"
        onClose={() => setAction(null)}
        values={{ status: draft.status }}
        onConfirm={async ({ reason, status }) => patch({ status, reason })}
      />

      <ReasonModal
        isOpen={action === "profile"}
        title="Sửa hồ sơ"
        confirmLabel="Lưu hồ sơ"
        onClose={() => setAction(null)}
        values={{ email: draft.email, displayName: draft.displayName }}
        onConfirm={async ({ reason, email, displayName }) => patch({ email, displayName, reason })}
      />

      <ReasonModal
        isOpen={action === "password"}
        title="Đặt lại mật khẩu"
        description="Mọi phiên đăng nhập hiện tại sẽ bị hủy. Mật khẩu không bao giờ được ghi vào nhật ký."
        confirmLabel="Đặt lại"
        onClose={() => { setAction(null); setDraft((d) => ({ ...d, password: "" })); }}
        values={{ password: draft.password }}
        onConfirm={async ({ reason, password }) => {
          const result = await patch({ password, reason });
          if (result.ok) setDraft((d) => ({ ...d, password: "" }));
          return result;
        }}
      />
    </div>
  );
}
