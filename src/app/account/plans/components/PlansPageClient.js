"use client";

import { useState, useEffect, useCallback } from "react";
import WalletSummary from "./WalletSummary";
import MyPlans from "./MyPlans";
import MyOrders from "./MyOrders";
import BuyPlans from "./BuyPlans";

const ORDER_CONFIRMED = "Order created. Transfer the amount, then an admin will approve it.";

export default function PlansPageClient() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [wallet, setWallet] = useState({ availableNanoUsd: 0, overdraftNanoUsd: 0, plans: [] });
  const [plans, setPlans] = useState([]);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [buyingId, setBuyingId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "success" | "error", message }

  const loadWalletAndPlans = useCallback(async () => {
    setLoadError("");
    try {
      const [walletRes, plansRes] = await Promise.all([
        fetch("/api/account/wallet", { cache: "no-store" }),
        fetch("/api/account/plans", { cache: "no-store" }),
      ]);

      const walletData = await walletRes.json().catch(() => ({}));
      const plansData = await plansRes.json().catch(() => ({}));

      if (!walletRes.ok) throw new Error(walletData.error || "Failed to load your balance");
      if (!plansRes.ok) throw new Error(plansData.error || "Failed to load plans");

      setWallet({
        availableNanoUsd: walletData.availableNanoUsd || 0,
        overdraftNanoUsd: walletData.overdraftNanoUsd || 0,
        plans: Array.isArray(walletData.plans) ? walletData.plans : [],
      });
      setPlans(Array.isArray(plansData.plans) ? plansData.plans : []);
    } catch (e) {
      setLoadError(e.message || "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const res = await fetch("/api/account/orders", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load orders");
      setOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Failed to load orders" });
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWalletAndPlans();
    loadOrders();
  }, [loadWalletAndPlans, loadOrders]);

  const buy = async (plan) => {
    setBuyingId(plan.id);
    setNotice(null);
    try {
      const res = await fetch("/api/account/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not create the order");
      setNotice({ type: "success", message: ORDER_CONFIRMED });
      await loadOrders();
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Could not create the order" });
    } finally {
      setBuyingId(null);
    }
  };

  const cancel = async (order) => {
    setCancellingId(order.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/account/orders/${order.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not cancel the order");
      setNotice({ type: "success", message: "Order cancelled." });
      await loadOrders();
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Could not cancel the order" });
    } finally {
      setCancellingId(null);
    }
  };

  const activePlans = wallet.plans.filter(
    (plan) => plan.status === "active" && (!plan.expiresAt ||
      // Wall clock is intentional here: a plan that lapses while the page is
      // open must drop out of the count on the next render.
      // eslint-disable-next-line react-hooks/purity
      Date.parse(plan.expiresAt) > Date.now())
  );

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <header className="flex flex-col gap-1.5">
        <span className="meta text-text-muted">Account</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">Plans and balance</h1>
        <p className="max-w-xl text-sm text-text-muted">
          Your credit, what it expires, and the plans you can buy. Payment is a manual transfer
          arranged after you place an order.
        </p>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger">error</span>
          <p className="flex-1 text-sm text-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => { setLoading(true); loadWalletAndPlans(); }}
            className="h-8 px-3 border border-danger/40 font-mono text-[10px] uppercase tracking-[0.12em] text-danger"
          >
            Retry
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`flex items-start gap-2 px-4 py-3 border ${
            notice.type === "error"
              ? "border-danger/40 bg-danger/5 text-danger"
              : "border-brand-500/40 bg-brand-500/5 text-brand-700 dark:text-brand-400"
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">
            {notice.type === "error" ? "error" : "check_circle"}
          </span>
          <p className="flex-1 text-sm">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
            className="opacity-70 hover:opacity-100"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      <WalletSummary
        loading={loading}
        availableNanoUsd={wallet.availableNanoUsd}
        overdraftNanoUsd={wallet.overdraftNanoUsd}
        planCount={activePlans.length}
      />

      <MyPlans plans={wallet.plans} loading={loading} />

      <MyOrders
        orders={orders}
        loading={ordersLoading}
        cancellingId={cancellingId}
        onCancel={cancel}
      />

      <BuyPlans plans={plans} loading={loading} buyingId={buyingId} onBuy={buy} />

      {!loading && plans.length > 0 && (
        <p className="border-t border-border pt-6 text-[11px] text-text-muted">
          Prices and credit are locked in when you place an order. Approval adds the plan credit to
          your balance, after repaying any overdraft.
        </p>
      )}
    </div>
  );
}
