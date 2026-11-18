"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Input from "./Input";
import Select from "./Select";
import Toggle from "./Toggle";
import { ConfirmModal } from "./Modal";

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

const ENDPOINT_HINT = {
  s3: "Để trống = https://s3.<region>.amazonaws.com",
  r2: "https://<account-id>.r2.cloudflarestorage.com",
  b2: "https://s3.<region>.backblazeb2.com",
  spaces: "https://<region>.digitaloceanspaces.com",
  minio: "https://minio.ten-mien-cua-ban.com",
  other: "https://endpoint-s3-cua-ban.com",
};

const PUBLIC_HINT = {
  r2: "Domain r2.dev hoặc custom domain gắn vào bucket, ví dụ https://pub-xxxx.r2.dev",
  s3: "Bucket/CloudFront công khai, ví dụ https://<bucket>.s3.<region>.amazonaws.com",
};

const EMPTY = {
  provider: "r2",
  endpoint: "",
  region: "auto",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  publicBaseUrl: "",
  pathPrefix: "",
  forcePathStyle: true,
  enabled: true,
};

function formOf(storage) {
  if (!storage) return EMPTY;
  return {
    provider: storage.provider,
    endpoint: storage.endpoint || "",
    region: storage.region || "",
    bucket: storage.bucket || "",
    accessKeyId: "",
    secretAccessKey: "",
    publicBaseUrl: storage.publicBaseUrl || "",
    pathPrefix: storage.pathPrefix || "",
    forcePathStyle: storage.forcePathStyle,
    enabled: storage.enabled,
  };
}

function statusOf(storage) {
  if (!storage) return { variant: "default", label: "Chưa kết nối" };
  if (!storage.enabled) return { variant: "default", label: "Đang tắt" };
  if (storage.lastTestOk === true) return { variant: "success", label: "Đã kết nối" };
  if (storage.lastTestOk === false) return { variant: "error", label: "Lỗi" };
  return { variant: "warning", label: "Chưa kiểm tra" };
}

/**
 * The image storage (S3-compatible CDN) form, shared by the customer page
 * (`/account/storage`) and the admin user page. `apiBase` is the storage
 * route; `${apiBase}/test` re-runs the test. Secrets are write-only: the page
 * never receives them, and leaving a field blank keeps the stored value.
 */
export default function StorageConfigPanel({ apiBase, audience = "customer" }) {
  const [loading, setLoading] = useState(true);
  const [storage, setStorage] = useState(null);
  const [providers, setProviders] = useState({});
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const apply = useCallback((body) => {
    setStorage(body.storage || null);
    setProviders(body.providers || {});
    setForm(formOf(body.storage));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiBase, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được cấu hình CDN");
      apply(body);
    } catch (e) {
      setError(e.message || "Không tải được cấu hình CDN");
    } finally {
      setLoading(false);
    }
  }, [apiBase, apply]);

  useEffect(() => { load(); }, [load]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const field = (key) => (e) => set(key)(e.target.value);

  const pickProvider = (e) => {
    const id = e.target.value;
    const preset = providers[id];
    setForm((f) => ({
      ...f,
      provider: id,
      region: preset?.region ?? f.region,
      forcePathStyle: preset?.forcePathStyle ?? f.forcePathStyle,
    }));
  };

  const call = async (kind, init) => {
    setBusy(kind);
    setError("");
    setResult(null);
    try {
      const res = await fetch(kind === "test" ? `${apiBase}/test` : apiBase, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không thực hiện được");
        return;
      }
      apply(body);
      if (body.test) setResult(body.test);
      else if (kind === "remove") setResult({ removed: true });
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setBusy("");
    }
  };

  const save = () => call("save", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form),
  });

  if (loading) return <div className="h-64 animate-pulse border border-border bg-surface-2" aria-busy="true" aria-label="Đang tải" />;

  const status = statusOf(storage);
  const providerOptions = Object.entries(providers).map(([value, p]) => ({ value, label: p.label }));
  const who = audience === "admin" ? "Khách này" : "Bạn";

  return (
    <section className="flex flex-col gap-5 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h2 className="meta text-text-muted">CDN lưu ảnh</h2>
          <p className="text-sm text-text-muted">
            Ảnh do model tạo ra được tải lên kho lưu trữ này và trả về link của kho, không trả link trung gian.
            {` ${who} `}phải kết nối kho trước khi dùng model ảnh. Hỗ trợ mọi dịch vụ chuẩn S3: Amazon S3, Cloudflare R2,
            Backblaze B2, DigitalOcean Spaces, MinIO…
          </p>
        </div>
        <Badge variant={status.variant} dot>{status.label}</Badge>
      </div>

      {storage ? (
        <dl className="grid gap-x-6 gap-y-1 font-mono text-[12px] text-text-muted sm:grid-cols-[max-content_1fr]">
          <dt>Bucket</dt>
          <dd className="text-text-main [overflow-wrap:anywhere]">{storage.bucket} @ {storage.endpoint}</dd>
          <dt>Access Key</dt>
          <dd className="text-text-main">{storage.accessKeyIdMasked}</dd>
          <dt>Link trả về</dt>
          <dd className="text-text-main [overflow-wrap:anywhere]">{storage.publicBaseUrl || "Link ký sẵn, hạn 7 ngày"}</dd>
          {storage.lastTestAt ? (
            <>
              <dt>Lần ghi gần nhất</dt>
              <dd className="text-text-main">
                {DATE.format(new Date(storage.lastTestAt))} · {storage.lastTestOk ? "thành công" : "thất bại"}
              </dd>
            </>
          ) : null}
          {storage.lastError ? (
            <>
              <dt>Lỗi</dt>
              <dd className="text-red-700 dark:text-red-400 [overflow-wrap:anywhere]">{storage.lastError}</dd>
            </>
          ) : null}
          {audience === "admin" && storage.updatedBy ? (
            <>
              <dt>Sửa bởi</dt>
              <dd className="text-text-main">{storage.updatedBy === "customer" ? "khách" : storage.updatedBy}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Loại lưu trữ"
          aria-label="Loại lưu trữ"
          options={providerOptions}
          value={form.provider}
          onChange={pickProvider}
        />
        <Input label="Endpoint" value={form.endpoint} onChange={field("endpoint")} placeholder={ENDPOINT_HINT[form.provider]} hint={form.provider === "s3" ? "Có thể để trống với Amazon S3" : undefined} />
        <Input label="Bucket" value={form.bucket} onChange={field("bucket")} placeholder="ten-bucket" />
        <Input label="Region" value={form.region} onChange={field("region")} placeholder={providers[form.provider]?.region || "us-east-1"} />
        <Input
          label="Access Key ID"
          value={form.accessKeyId}
          onChange={field("accessKeyId")}
          autoComplete="off"
          placeholder={storage ? `Giữ nguyên (${storage.accessKeyIdMasked})` : "AKIA… / key id của R2"}
        />
        <Input
          label="Secret Access Key"
          type="password"
          value={form.secretAccessKey}
          onChange={field("secretAccessKey")}
          autoComplete="new-password"
          placeholder={storage?.hasSecret ? "Giữ nguyên secret đã lưu" : "Secret"}
        />
        <Input
          label="Link công khai (tuỳ chọn)"
          value={form.publicBaseUrl}
          onChange={field("publicBaseUrl")}
          placeholder={PUBLIC_HINT[form.provider] || "https://cdn.ten-mien-cua-ban.com"}
          hint="Để trống thì link trả về là link ký sẵn, hết hạn sau 7 ngày."
        />
        <Input label="Thư mục (tuỳ chọn)" value={form.pathPrefix} onChange={field("pathPrefix")} placeholder="derouter" />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-sm text-text-main">Path-style URL</span>
            <span className="text-xs text-text-muted">Bật cho R2, MinIO, B2. Tắt cho Amazon S3 và Spaces (bucket nằm trong tên miền).</span>
          </span>
          <Toggle aria-label="Path-style URL" checked={form.forcePathStyle} onChange={set("forcePathStyle")} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-sm text-text-main">Dùng kho này</span>
            <span className="text-xs text-text-muted">Tắt thì model ảnh bị từ chối như khi chưa kết nối.</span>
          </span>
          <Toggle aria-label="Dùng kho này" checked={form.enabled} onChange={set("enabled")} />
        </div>
      </div>

      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {result?.removed ? <p role="status" className="text-sm text-text-muted">Đã ngắt kết nối CDN.</p> : null}
      {result && !result.removed ? (
        <p
          role="status"
          className={result.ok
            ? "border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400"
            : "border border-red-500/40 bg-red-500/5 px-4 py-2 text-sm text-red-700 dark:text-red-400"}
        >
          {result.ok ? "Kiểm tra thành công: đã ghi và xoá được file thử." : `Kiểm tra thất bại: ${result.error}`}
          {result.ok && result.warning ? ` Lưu ý: ${result.warning}.` : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} loading={busy === "save"} disabled={Boolean(busy)}>Lưu & kiểm tra</Button>
        {storage ? (
          <>
            <Button variant="secondary" onClick={() => call("test", { method: "POST" })} loading={busy === "test"} disabled={Boolean(busy)}>
              Kiểm tra lại
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(true)} disabled={Boolean(busy)}>Ngắt kết nối</Button>
          </>
        ) : null}
      </div>

      <ConfirmModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); call("remove", { method: "DELETE" }); }}
        title="Ngắt kết nối CDN"
        message="Cấu hình và secret đã lưu bị xoá. Model ảnh sẽ bị từ chối cho tới khi kết nối lại. Ảnh đã tải lên kho vẫn còn nguyên."
        confirmText="Ngắt kết nối"
      />
    </section>
  );
}
