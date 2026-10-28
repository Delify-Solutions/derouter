"use client";

import { useState } from "react";
import GiftRedeemForm from "./GiftRedeemForm";
import RedemptionHistory from "./RedemptionHistory";

export default function GiftPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Account</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">Redeem a gift code</h1>
        <p className="max-w-xl text-sm text-text-muted">
          Enter the code you were given. It is added to your balance immediately and cannot be reused.
        </p>
      </div>

      <section className="border border-border bg-surface p-6">
        <GiftRedeemForm onRedeemed={() => setRefreshKey((k) => k + 1)} />
      </section>

      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Your redemptions</span>
        <RedemptionHistory refreshKey={refreshKey} />
      </section>
    </div>
  );
}
