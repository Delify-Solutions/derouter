"use client";

import { useCallback, useState } from "react";
import { Page, Panel, Section } from "@/app/account/components/ui";
import GiftRedeemForm from "./GiftRedeemForm";
import RedemptionHistory from "./RedemptionHistory";
import ReferralGiftCallout from "./ReferralGiftCallout";

export default function GiftPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);
  // The referral welcome gift, once the callout has resolved it (design D7).
  const [referralCode, setReferralCode] = useState("");

  const onReferralCode = useCallback((code) => setReferralCode(code || ""), []);

  return (
    <Page
      title="Mã quà tặng"
      description="Nhập mã bạn được tặng. Credit được cộng ngay vào tài khoản và mỗi mã chỉ dùng được một lần."
    >
      <ReferralGiftCallout onCode={onReferralCode} refreshKey={refreshKey} />

      <Section title="Nhập mã" description="Dấu gạch ngang không bắt buộc, chữ hoa hay thường đều được.">
        <Panel className="p-6">
          <GiftRedeemForm
            initialCode={referralCode}
            onRedeemed={() => {
              setRefreshKey((k) => k + 1);
              // Redeemed: the code is spent, so it must not be prefilled again.
              setReferralCode("");
            }}
          />
        </Panel>
      </Section>

      <Section title="Lịch sử nhập mã" description="Các mã bạn đã nhập, kèm thứ nhận được và hạn dùng.">
        <RedemptionHistory refreshKey={refreshKey} />
      </Section>
    </Page>
  );
}
