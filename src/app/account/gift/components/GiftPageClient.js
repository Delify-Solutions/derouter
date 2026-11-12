"use client";

import { useCallback, useState } from "react";
import { Page, Panel, Section } from "@/app/account/components/ui";
import GiftRedeemForm from "./GiftRedeemForm";
import RedemptionHistory from "./RedemptionHistory";
import ReferralGiftCallout from "./ReferralGiftCallout";
import AvailableGifts from "./AvailableGifts";
import ChannelOfferModal from "./ChannelOfferModal";
import { grantText } from "./redeemApi";

export default function GiftPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);
  // The referral welcome gift, once the callout has resolved it (design D7).
  const [referralCode, setReferralCode] = useState("");
  // After a welcome code: the channel-join voucher to offer (change channel-gift).
  const [offer, setOffer] = useState(null);
  // A code taken from "Mã có thể sử dụng" (the typed form shows its own result).
  const [taken, setTaken] = useState(null);

  const onReferralCode = useCallback((code) => setReferralCode(code || ""), []);

  const afterRedeem = useCallback((data) => {
    setRefreshKey((k) => k + 1);
    if (data?.channelOffer?.code && data.channelOffer.channelUrl) setOffer(data.channelOffer);
  }, []);

  const onCardRedeemed = useCallback((data) => {
    setTaken(data || null);
    afterRedeem(data);
  }, [afterRedeem]);

  return (
    <Page
      title="Mã quà tặng"
      description="Nhập mã bạn được tặng. Credit được cộng ngay vào tài khoản và mỗi mã chỉ dùng được một lần."
    >
      <ReferralGiftCallout onCode={onReferralCode} refreshKey={refreshKey} />

      {taken ? (
        <div role="status" className="mb-6 flex items-start gap-2 border border-brand-500/30 bg-brand-500/5 px-4 py-3 text-sm text-brand-700 dark:text-brand-400">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
          <span>
            Đã nhận{" "}
            {grantText({
              planName: taken.planName,
              creditNanoUsd: taken.creditAppliedNanoUsd,
              unlimitedCredit: taken.unlimitedCredit,
            })}
            . Xem chi tiết ở Lịch sử nhập mã bên dưới.
          </span>
        </div>
      ) : null}

      <AvailableGifts refreshKey={refreshKey} onRedeemed={onCardRedeemed} />

      <Section title="Nhập mã" description="Dấu gạch ngang không bắt buộc, chữ hoa hay thường đều được.">
        <Panel className="p-6">
          <GiftRedeemForm
            initialCode={referralCode}
            onRedeemed={(data) => {
              setTaken(null);
              afterRedeem(data);
              // Redeemed: the code is spent, so it must not be prefilled again.
              setReferralCode("");
            }}
          />
        </Panel>
      </Section>

      <Section title="Lịch sử nhập mã" description="Các mã bạn đã nhập, kèm thứ nhận được và hạn dùng.">
        <RedemptionHistory refreshKey={refreshKey} />
      </Section>

      {offer ? (
        <ChannelOfferModal
          offer={offer}
          onClose={() => setOffer(null)}
          onRedeemed={() => setRefreshKey((k) => k + 1)}
        />
      ) : null}
    </Page>
  );
}
