"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Card, Input, Toggle } from "@/shared/components";
import { PromoPopupDialog } from "@/app/landing/components/PromoPopup";
import {
  DEFAULT_DELAY_SEC,
  DEFAULT_REPEAT_MINUTES,
  MAX_DELAY_SEC,
  MAX_REPEAT_MINUTES,
  normalizePromoCode,
  promoPopupState,
  readPromoPopup,
} from "@/shared/utils/promoPopup.js";

const STATUS = {
  live: { icon: "visibility", text: "Đang hiện trên trang chủ", className: "border-brand-500/40 text-brand-700 dark:text-brand-400" },
  disabled: { icon: "visibility_off", text: "Đang ẩn: chưa bật popup", className: "border-amber-500/50 text-amber-800 dark:text-amber-300" },
  empty: { icon: "visibility_off", text: "Đang ẩn: chưa có nội dung", className: "border-amber-500/50 text-amber-800 dark:text-amber-300" },
};

const KEYS = ["popupEnabled", "popupTitle", "popupBody", "popupCode", "popupCta", "popupDelaySec", "popupRepeatMinutes"];

function Warning({ children }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300">
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">warning</span>
      <span>{children}</span>
    </p>
  );
}

Warning.propTypes = { children: PropTypes.node };

// Active gift codes, for the suggestion list and the "unknown code" warning.
function useActiveGiftCodes() {
  const [codes, setCodes] = useState(null); // null = loading, false = could not load
  useEffect(() => {
    let cancelled = false;
    fetch("/api/gift-codes", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setCodes(false);
          return;
        }
        const now = Date.now();
        setCodes(
          (data.codes || []).filter((c) => {
            if (!c.isActive) return false;
            if (c.startsAt && Date.parse(c.startsAt) > now) return false;
            if (c.expiresAt && Date.parse(c.expiresAt) < now) return false;
            if (c.maxRedemptions && (c.redeemedCount ?? 0) >= c.maxRedemptions) return false;
            return true;
          })
        );
      })
      .catch(() => { if (!cancelled) setCodes(false); });
    return () => { cancelled = true; };
  }, []);
  return codes;
}

/**
 * Promotional popup editor (spec promo-popup). `saved` drives the status line
 * (what visitors see now); the preview shows the draft.
 */
export default function PopupCard({ copy, saved, onChange }) {
  const status = STATUS[promoPopupState(saved)];
  const draft = readPromoPopup(copy);
  const dirty = KEYS.some((key) => (copy[key] ?? "") !== (saved?.[key] ?? ""));
  const codes = useActiveGiftCodes();
  const codeKey = normalizePromoCode(copy.popupCode);
  const known = useMemo(
    () => (codes ? codes.find((c) => normalizePromoCode(c.code) === codeKey) : null),
    [codes, codeKey]
  );

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-main">Popup khuyến mãi</h3>
          <p className="mt-1 text-[11px] text-text-muted">
            Hộp thoại hiện trên trang chủ sau vài giây. Khách bấm vào mã để copy; bấm nút thì đăng ký và được đưa tới
            trang Mã quà tặng với mã đã điền sẵn.
          </p>
        </div>
        <p role="status" className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] ${status.className}`}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{status.icon}</span>
          {status.text}
        </p>
      </div>

      {dirty && (
        <p className="-mt-2 flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit_note</span>
          Có thay đổi chưa lưu: trạng thái trên là bản đang chạy, bấm &quot;Lưu nội dung&quot; để áp dụng.
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Toggle
            checked={Boolean(copy.popupEnabled)}
            onChange={(value) => onChange("popupEnabled", value)}
            label="Bật popup"
            description={copy.popupEnabled ? "Bật: hiện khi có nội dung" : "Tắt: không hiện trên trang chủ"}
          />
          <Input
            label="Tiêu đề"
            value={copy.popupTitle ?? ""}
            onChange={(e) => onChange("popupTitle", e.target.value)}
            placeholder="Tặng $5 cho tài khoản mới"
            maxLength={120}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="popup-body" className="text-sm font-medium text-text-main">Nội dung</label>
            <textarea
              id="popup-body"
              value={copy.popupBody ?? ""}
              onChange={(e) => onChange("popupBody", e.target.value)}
              rows={3}
              maxLength={600}
              placeholder="Đăng ký và nhập mã bên dưới để nhận credit dùng thử."
              className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Input
              label="Mã quà tặng (để trống nếu không kèm mã)"
              value={copy.popupCode ?? ""}
              onChange={(e) => onChange("popupCode", e.target.value.toUpperCase())}
              placeholder="WELCOME"
              list="popup-code-options"
              inputClassName="font-mono"
              autoComplete="off"
            />
            <datalist id="popup-code-options">
              {(codes || []).map((c) => (
                <option key={c.id} value={c.code}>{c.note || (c.newUserOnly ? "Người mới" : "")}</option>
              ))}
            </datalist>
            {codeKey && codes && !known && (
              <Warning>Không thấy mã này trong các mã đang dùng được (đã tắt, chưa tới ngày, hết hạn, hết lượt hoặc gõ sai).</Warning>
            )}
            {codeKey && codes === false && (
              <p className="text-[11px] text-text-muted">Không tải được danh sách mã quà tặng để kiểm tra mã này.</p>
            )}
            {known?.newUserOnly && (
              <p className="text-[11px] text-text-muted">Mã người mới: khách cần liên kết Telegram, trang Mã quà tặng sẽ hướng dẫn.</p>
            )}
          </div>
          <Input
            label="Chữ trên nút"
            value={copy.popupCta ?? ""}
            onChange={(e) => onChange("popupCta", e.target.value)}
            placeholder={draft.code ? "Đăng ký nhận ưu đãi" : "Đăng ký ngay"}
            maxLength={40}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Hiện sau (giây)"
              type="number"
              min="0"
              max={MAX_DELAY_SEC}
              value={copy.popupDelaySec ?? ""}
              onChange={(e) => onChange("popupDelaySec", e.target.value)}
              placeholder={String(DEFAULT_DELAY_SEC)}
              hint={`Để trống = ${DEFAULT_DELAY_SEC} giây.`}
            />
            <Input
              label="Hiện lại sau (phút)"
              type="number"
              min="0"
              max={MAX_REPEAT_MINUTES}
              value={copy.popupRepeatMinutes ?? ""}
              onChange={(e) => onChange("popupRepeatMinutes", e.target.value)}
              placeholder={String(DEFAULT_REPEAT_MINUTES)}
              hint={`Sau khi khách đóng. 0 = mỗi lần mở trang, để trống = ${DEFAULT_REPEAT_MINUTES} phút. Sửa nội dung thì hiện lại ngay.`}
            />
          </div>
          {copy.popupEnabled && !draft.title && !draft.body && !draft.code && (
            <Warning>Đã bật nhưng chưa có tiêu đề, nội dung hay mã: popup sẽ không hiện.</Warning>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
            Xem trước{dirty ? " (bản đang sửa, chưa lưu)" : ""}
          </p>
          <div className="flex items-center justify-center border border-border bg-black/40 p-6" inert>
            <PromoPopupDialog popup={draft} onClose={() => {}} onCopy={() => {}} preview />
          </div>
        </div>
      </div>
    </Card>
  );
}

PopupCard.propTypes = {
  copy: PropTypes.object.isRequired,
  saved: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};
