"use client";

import PropTypes from "prop-types";
import { Card, Input, Toggle } from "@/shared/components";
import AnnouncementBanner from "@/app/landing/components/AnnouncementBanner";

// Same rule AnnouncementBanner applies: the strip renders only when it is enabled
// AND has non-blank text. Kept next to the card so the status line and the
// preview can never disagree with what the landing page does.
export function bannerState(copy) {
  const text = typeof copy?.bannerText === "string" ? copy.bannerText.trim() : "";
  if (!copy?.bannerEnabled) return "disabled";
  if (!text) return "empty";
  return "live";
}

const STATUS = {
  live: {
    icon: "visibility",
    text: "Đang hiện trên trang chủ",
    className: "border-brand-500/40 text-brand-700 dark:text-brand-400",
  },
  disabled: {
    icon: "visibility_off",
    text: "Đang ẩn: chưa bật thông báo",
    className: "border-amber-500/50 text-amber-800 dark:text-amber-300",
  },
  empty: {
    icon: "visibility_off",
    text: "Đang ẩn: chưa có nội dung thông báo",
    className: "border-amber-500/50 text-amber-800 dark:text-amber-300",
  },
};

function FieldWarning({ id, children }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300">
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">warning</span>
      <span>{children}</span>
    </p>
  );
}

FieldWarning.propTypes = { id: PropTypes.string, children: PropTypes.node };

/**
 * Announcement strip editor. `saved` is the copy as last loaded from / saved to
 * the server — the status line describes what visitors see right now, which is
 * the saved state, never the unsaved draft.
 */
export default function BannerCard({ copy, saved, onChange }) {
  const status = STATUS[bannerState(saved)];
  const draftText = typeof copy.bannerText === "string" ? copy.bannerText.trim() : "";
  const draftEnabled = Boolean(copy.bannerEnabled);
  const draftState = bannerState(copy);
  const bannerDirty =
    (copy.bannerText ?? "") !== (saved?.bannerText ?? "") ||
    (copy.bannerHref ?? "") !== (saved?.bannerHref ?? "") ||
    draftEnabled !== Boolean(saved?.bannerEnabled);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-main">Thông báo đầu trang</h3>
          <p className="mt-1 text-[11px] text-text-muted">
            Dải thông báo phía trên tiêu đề, giống &quot;New … is now available&quot; của opencode.ai/go.
            Chỉ hiện khi đã bật và có nội dung.
          </p>
        </div>
        <p
          role="status"
          className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] ${status.className}`}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{status.icon}</span>
          {status.text}
        </p>
      </div>

      {bannerDirty ? (
        <p className="-mt-2 flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit_note</span>
          Có thay đổi chưa lưu: trạng thái trên là bản đang chạy, bấm &quot;Lưu nội dung&quot; để áp dụng.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Input
            label="Nội dung thông báo"
            value={copy.bannerText ?? ""}
            onChange={(e) => onChange("bannerText", e.target.value)}
            aria-describedby={draftEnabled && !draftText ? "banner-text-warning" : undefined}
          />
          {draftEnabled && !draftText ? (
            <FieldWarning id="banner-text-warning">
              Đã bật nhưng chưa có nội dung: thông báo sẽ không hiện.
            </FieldWarning>
          ) : null}
        </div>
        <Input
          label="Liên kết (để trống nếu chỉ thông báo)"
          value={copy.bannerHref ?? ""}
          onChange={(e) => onChange("bannerHref", e.target.value)}
          placeholder="/docs/bat-dau hoặc https://…"
        />
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Toggle
            checked={draftEnabled}
            onChange={(value) => onChange("bannerEnabled", value)}
            label="Bật thông báo"
            description={draftEnabled ? "Bật: hiện khi có nội dung" : "Tắt: không hiện trên trang chủ"}
          />
          {!draftEnabled && draftText ? (
            <FieldWarning>Có nội dung nhưng chưa bật: thông báo sẽ không hiện.</FieldWarning>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          Xem trước{bannerDirty ? " (bản đang sửa, chưa lưu)" : ""}
        </p>
        <div className="border border-border">
          {draftState === "live" ? (
            // inert: the preview is a picture of the strip, not a second link to follow.
            <div inert>
              <AnnouncementBanner text={copy.bannerText} href={copy.bannerHref} enabled={draftEnabled} />
            </div>
          ) : (
            <p className="flex items-center gap-1.5 bg-surface-2 px-4 py-2.5 text-[12px] text-text-muted">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">visibility_off</span>
              {draftState === "disabled"
                ? "Không có dải thông báo: chưa bật."
                : "Không có dải thông báo: chưa có nội dung."}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

BannerCard.propTypes = {
  copy: PropTypes.object.isRequired,
  saved: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};
