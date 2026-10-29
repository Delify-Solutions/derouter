"use client";

import { useState } from "react";
import { Page, Panel, Section } from "@/app/account/components/ui";
import GiftRedeemForm from "./GiftRedeemForm";
import RedemptionHistory from "./RedemptionHistory";

export default function GiftPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Page
      title="Mã quà tặng"
      description="Nhập mã bạn được tặng. Credit được cộng ngay vào tài khoản và mỗi mã chỉ dùng được một lần."
    >
      <Section title="Nhập mã" description="Dấu gạch ngang không bắt buộc, chữ hoa hay thường đều được.">
        <Panel className="p-6">
          <GiftRedeemForm onRedeemed={() => setRefreshKey((k) => k + 1)} />
        </Panel>
      </Section>

      <Section title="Lịch sử nhập mã" description="Các mã bạn đã nhập, kèm thứ nhận được và hạn dùng.">
        <RedemptionHistory refreshKey={refreshKey} />
      </Section>
    </Page>
  );
}
