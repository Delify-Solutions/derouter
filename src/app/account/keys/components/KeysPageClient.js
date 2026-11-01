"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input, Modal } from "@/shared/components";
import { ActionButton, Empty, ListRow, Page, Section, Tag } from "@/app/account/components/ui";
import CopyBlock from "@/app/account/components/CopyBlock";
import { USAGE_KEY_STORAGE } from "@/shared/constants/usageKeyStorage";

const NAME_MAX = 80;

const ICON_BUTTON =
  "flex size-9 items-center justify-center border border-border bg-surface text-text-muted transition-colors duration-150 " +
  "hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return `${time} ${formatDate(value)}`;
}

/** "dùng lần cuối 20:53 01/11/2026", or "chưa dùng" for a key with no request on record. */
function lastUsedLabel(value) {
  const at = formatDateTime(value);
  return at ? `dùng lần cuối ${at}` : "chưa dùng";
}

export default function KeysPageClient({ publicBaseUrl = "" }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // The secret of a key just created, for the confirmation dialog. The list itself
  // never carries secrets; they are fetched one at a time on an explicit press.
  const [createdSecret, setCreatedSecret] = useState("");
  const [createdName, setCreatedName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Id of the key being handed to /usage, while the request is in flight.
  const [openingUsageId, setOpeningUsageId] = useState(null);
  // Secrets the customer chose to reveal, by key id. Memory only: a reload hides them.
  const [revealed, setRevealed] = useState({});
  // Per-key state of the show/copy buttons: "loading" | "copied".
  const [secretState, setSecretState] = useState({});
  // Error of a per-row action (show, copy, usage). Shown above the list without
  // unmounting it, unlike loadError, which replaces the list.
  const [actionError, setActionError] = useState("");

  const baseUrl = useMemo(() => {
    const configured = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (configured) return `${configured}/v1`;
    if (typeof window !== "undefined") return `${window.location.origin}/v1`;
    return "/v1";
  }, [publicBaseUrl]);

  const load = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    try {
      const res = await fetch("/api/account/keys", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || "Không tải được danh sách API key");
        return;
      }
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch {
      setLoadError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setName("");
    setFormError("");
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setFormError("Nhập tên cho key"); return; }
    if (trimmed.length > NAME_MAX) { setFormError(`Tên key tối đa ${NAME_MAX} ký tự`); return; }

    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/account/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không tạo được key");
        return;
      }
      setCreateOpen(false);
      setCreatedSecret(data.secret || "");
      setCreatedName(data.key?.name || trimmed);
      // The list itself can be refreshed right away; the secret lives outside it.
      await load();
    } catch {
      setFormError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/keys/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok) {
        setKeys((prev) => prev.filter((key) => key.id !== deleteTarget.id));
      } else {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || "Không xóa được key");
      }
    } catch {
      setLoadError("Không kết nối được máy chủ");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const fetchSecret = async (id) => {
    const res = await fetch(`/api/account/keys/${encodeURIComponent(id)}/secret`, {
      method: "POST",
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Phiên đăng nhập đã hết hạn, hãy đăng nhập lại");
    if (res.status === 404) {
      // Deleted elsewhere (another tab, an admin): refresh the list.
      load();
      throw new Error("Key này không còn tồn tại");
    }
    if (res.status === 429) throw new Error("Thao tác quá nhanh, thử lại sau ít phút");
    if (!res.ok || !data.secret) throw new Error("Không lấy được key, thử lại sau");
    return data.secret;
  };

  const setKeyState = (id, value) => setSecretState((prev) => ({ ...prev, [id]: value }));

  const toggleReveal = async (key) => {
    if (revealed[key.id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[key.id];
        return next;
      });
      return;
    }
    setActionError("");
    setKeyState(key.id, "loading");
    try {
      const secret = await fetchSecret(key.id);
      setRevealed((prev) => ({ ...prev, [key.id]: secret }));
      setKeyState(key.id, null);
    } catch (error) {
      setKeyState(key.id, null);
      setActionError(error.message || "Không lấy được key, thử lại sau");
    }
  };

  const copySecret = async (key) => {
    setActionError("");
    setKeyState(key.id, "loading");
    let secret;
    try {
      secret = revealed[key.id] || (await fetchSecret(key.id));
    } catch (error) {
      setKeyState(key.id, null);
      setActionError(error.message || "Không lấy được key, thử lại sau");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      setKeyState(key.id, null);
      setActionError("Không sao chép được key. Bấm hiện key rồi sao chép thủ công.");
      return;
    }
    setKeyState(key.id, "copied");
    setTimeout(() => setSecretState((prev) => (prev[key.id] === "copied" ? { ...prev, [key.id]: null } : prev)), 2000);
  };

  // /usage works from the raw key. The server hands this customer's own key over
  // only on this explicit press; it goes to the slot /usage reads on load and
  // never into the URL, so it stays out of the address bar, history and logs.
  const openUsage = async (key) => {
    setOpeningUsageId(key.id);
    setActionError("");
    try {
      let secret;
      try {
        secret = revealed[key.id] || (await fetchSecret(key.id));
      } catch (error) {
        setActionError(error.message || "Không mở được trang usage của key này");
        setOpeningUsageId(null);
        return;
      }
      try {
        localStorage.setItem(USAGE_KEY_STORAGE, secret);
      } catch {
        setActionError("Trình duyệt chặn lưu trữ cục bộ nên không mở được trang usage");
        setOpeningUsageId(null);
        return;
      }
      window.location.assign("/usage");
    } catch {
      setActionError("Không kết nối được máy chủ");
      setOpeningUsageId(null);
    }
  };

  const createAction = <ActionButton tone="solid" onClick={openCreate}>Tạo key</ActionButton>;

  return (
    <Page
      title="API key"
      description="Dùng key này để gọi model trong nhóm của bạn. Chỉ bạn xem được key, khi đã đăng nhập."
      actions={createAction}
    >
      <Section title="Kết nối" description="Trỏ client OpenAI hoặc Claude tới địa chỉ này.">
        <div className="flex flex-col gap-3">
          <CopyBlock prompt="url" value={baseUrl} label="Sao chép địa chỉ API" />
          <CopyBlock value={`curl ${baseUrl}/models -H "Authorization: Bearer <key>"`} label="Sao chép lệnh thử" />
        </div>
      </Section>

      <Section title="Key của bạn" description="Mỗi máy hoặc ứng dụng nên có một key riêng để thu hồi riêng khi cần.">
        {loadError ? (
          <div role="alert" className="flex items-start justify-between gap-4 border border-red-600/30 bg-red-500/10 px-5 py-4">
            <span className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
              <span>{loadError}</span>
            </span>
            <ActionButton size="sm" onClick={load}>Thử lại</ActionButton>
          </div>
        ) : loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2].map((row) => <div key={row} className="h-[74px] border border-border bg-surface-2" />)}
          </div>
        ) : keys.length === 0 ? (
          <Empty
            icon="key"
            title="Bạn chưa có API key"
            body="Tạo key đầu tiên để bắt đầu gọi model. Bạn có thể tạo nhiều key cho nhiều máy khác nhau."
            action={createAction}
          />
        ) : (
          <>
          {actionError ? (
            <div role="alert" className="mb-2 flex items-start justify-between gap-4 border border-red-600/30 bg-red-500/10 px-5 py-3">
              <span className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
                <span>{actionError}</span>
              </span>
              <button
                type="button"
                onClick={() => setActionError("")}
                aria-label="Đóng thông báo lỗi"
                className="flex size-7 shrink-0 items-center justify-center text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
              </button>
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <ListRow
                key={key.id}
                title={key.name || "—"}
                tags={
                  <Tag tone={key.isActive ? "success" : "neutral"} icon={key.isActive ? "check_circle" : "block"}>
                    {key.isActive ? "Đang dùng" : "Đã tắt"}
                  </Tag>
                }
                detail={
                  <>
                    {revealed[key.id] ? (
                      <span className="block break-all font-mono text-text-main">{revealed[key.id]}</span>
                    ) : null}
                    {`${key.keyPrefix ? `${key.keyPrefix}…` : "—"} · tạo ${formatDate(key.createdAt)} · ${lastUsedLabel(key.lastUsedAt)}`}
                  </>
                }
                actions={
                  <>
                    <button
                      type="button"
                      onClick={() => toggleReveal(key)}
                      disabled={secretState[key.id] === "loading"}
                      aria-label={`${revealed[key.id] ? "Ẩn" : "Hiện"} key ${key.name || key.keyPrefix || ""}`}
                      title={revealed[key.id] ? "Ẩn key" : "Hiện key"}
                      className={ICON_BUTTON}
                    >
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                        {revealed[key.id] ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => copySecret(key)}
                      disabled={secretState[key.id] === "loading"}
                      aria-label={`Sao chép key ${key.name || key.keyPrefix || ""}`}
                      title={secretState[key.id] === "copied" ? "Đã sao chép" : "Sao chép key"}
                      className={ICON_BUTTON}
                    >
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                        {secretState[key.id] === "copied" ? "check" : "content_copy"}
                      </span>
                      <span className="sr-only" role="status">{secretState[key.id] === "copied" ? "Đã sao chép key" : ""}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openUsage(key)}
                      disabled={openingUsageId !== null}
                      aria-busy={openingUsageId === key.id || undefined}
                      aria-label={`Xem usage của key ${key.name || key.keyPrefix || ""}`}
                      title="Mở trang /usage của key này"
                      className="flex h-9 items-center gap-2 border border-border bg-surface px-3 font-mono text-xs font-medium text-text-main transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span
                        className={`material-symbols-outlined text-[16px]${openingUsageId === key.id ? " animate-spin" : ""}`}
                        aria-hidden="true"
                      >
                        {openingUsageId === key.id ? "progress_activity" : "monitoring"}
                      </span>
                      {/* A technical term kept in English, so the page translator must not touch it. */}
                      <span data-i18n-skip="true">Usage</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Xóa key ${key.name || key.keyPrefix || ""}`}
                      title="Xóa key"
                      onClick={() => setDeleteTarget(key)}
                      className="flex size-9 items-center justify-center border border-border bg-surface text-text-muted transition-colors duration-150 hover:bg-red-500/10 hover:text-red-600"
                    >
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">delete</span>
                    </button>
                  </>
                }
              />
            ))}
          </ul>
          </>
        )}
      </Section>

      {/* Create */}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setFormError(""); }}
        title="Tạo API key"
        footer={
          <>
            <ActionButton tone="ghost" onClick={() => { setCreateOpen(false); setFormError(""); }} disabled={saving}>Hủy</ActionButton>
            <ActionButton tone="solid" onClick={submitCreate} loading={saving} disabled={!name.trim()}>Tạo</ActionButton>
          </>
        }
      >
        <Input
          label="Tên key"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Laptop cá nhân"
          error={formError}
          hint={`1–${NAME_MAX} ký tự`}
          maxLength={NAME_MAX}
          autoFocus
        />
      </Modal>

      {/* Secret of a key just created */}
      <Modal
        isOpen={!!createdSecret}
        onClose={() => setCreatedSecret("")}
        title="Đã tạo API key"
        closeOnOverlay={false}
        footer={<ActionButton tone="solid" onClick={() => setCreatedSecret("")}>Tôi đã lưu key</ActionButton>}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">
            Key <span className="font-mono">{createdName}</span> đã được tạo.
          </p>
          <CopyBlock prompt="key" value={createdSecret} label="Sao chép API key" />
          <div
            role="alert"
            className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">warning</span>
            <span>Sao chép key ngay để dán vào ứng dụng. Sau này bạn vẫn xem lại được ở danh sách key.</span>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Xóa API key"
        footer={
          <>
            <ActionButton tone="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Hủy</ActionButton>
            <ActionButton tone="solid" onClick={submitDelete} loading={deleting} className="border-red-600 bg-red-600 text-white hover:bg-red-700">Xóa key</ActionButton>
          </>
        }
      >
        <p className="text-sm text-text-main">
          Xóa key <span className="font-mono">{deleteTarget?.name || deleteTarget?.keyPrefix}</span>?
          Mọi ứng dụng đang dùng key này sẽ ngừng gọi được ngay. Không thể hoàn tác.
        </p>
      </Modal>
    </Page>
  );
}
