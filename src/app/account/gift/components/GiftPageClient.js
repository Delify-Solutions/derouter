"use client";

import { useState } from "react";
import GiftRedeemForm from "./GiftRedeemForm";
import RedemptionHistory from "./RedemptionHistory";

export default function GiftPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Tài khoản</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">Nhập mã quà tặng</h1>
        <p className="max-w-xl text-sm text-text-muted">
          Nhập mã bạn được tặng. Credit được cộng ngay vào tài khoản và mã không dùng lại được.
        </p>
      </div>

      <section className="border border-border bg-surface p-6">
        <GiftRedeemForm onRedeemed={() => setRefreshKey((k) => k + 1)} />
      </section>

      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Lịch sử nhập mã</span>
        <RedemptionHistory refreshKey={refreshKey} />
      </section>
    </div>
  );
}
