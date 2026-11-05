"use client";

import { useState } from "react";
import { Modal } from "@/shared/components";
import { ActionButton, buttonClass } from "@/app/account/components/ui";
import { grantText, redeemGift } from "./redeemApi";

/**
 * Shown right after a welcome (new-user) code is taken (change channel-gift):
 * join the Telegram channel to take one more voucher. `offer` is the redeem
 * response's `channelOffer` { code, creditNanoUsd, unlimitedCredit, planName, channelUrl }.
 */
export default function ChannelOfferModal({ offer, onClose, onRedeemed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const reward = grantText(offer);

  const take = async () => {
    setBusy(true);
    setError("");
    const result = await redeemGift(offer.code);
    setBusy(false);
    if (!result.ok) {
      setError(result.code === "channel_required"
        ? "Chưa thấy bạn trong kênh. Tham gia kênh bằng tài khoản Telegram đã liên kết rồi bấm lại."
        : result.error);
      return;
    }
    setDone(true);
    onRedeemed?.(result.data);
  };

  return (
    <Modal isOpen onClose={onClose} title="Nhận thêm 1 voucher" size="md">
      <div className="flex flex-col gap-4">
        {done ? (
          <div role="status" className="flex items-start gap-2 border border-brand-500/30 bg-brand-500/5 px-4 py-3 text-sm text-brand-700 dark:text-brand-400">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
            <span>Đã nhận thêm {reward}. Cảm ơn bạn đã tham gia kênh!</span>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-main">
              Tham gia kênh Telegram của chúng tôi để nhận thêm <strong className="font-mono">{reward}</strong>.
            </p>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-text-muted">
              <li>Mở kênh và bấm Tham gia, bằng tài khoản Telegram bạn đã liên kết.</li>
              <li>Quay lại đây, bấm &quot;Tôi đã tham gia, nhận ngay&quot;.</li>
            </ol>
            <p className="font-mono text-xs text-text-muted">Mã: <span className="text-text-main">{offer.code}</span> · mỗi Telegram nhận một lần</p>
            {error ? (
              <p role="alert" className="border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap gap-3">
          {done ? (
            <ActionButton tone="solid" onClick={onClose}>Đóng</ActionButton>
          ) : (
            <>
              <a href={offer.channelUrl} target="_blank" rel="noopener noreferrer" className={buttonClass({ tone: "solid" })}>
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
                Mở kênh Telegram
              </a>
              <ActionButton loading={busy} onClick={take}>Tôi đã tham gia, nhận ngay</ActionButton>
              <ActionButton tone="ghost" onClick={onClose}>Để sau</ActionButton>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
