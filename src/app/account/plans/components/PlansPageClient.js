"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CardSkeleton } from "@/shared/components";
import { ActionButton, Page, Section, Stat } from "@/app/account/components/ui";
import { PlanQueue } from "@/shared/components/billing";
import { fmtUsdNano } from "@/shared/utils/money";
import BuyPlans from "./BuyPlans";
import MyOrders from "./MyOrders";
import PlanHistory from "./PlanHistory";
import PlanTabs from "./PlanTabs";

const ORDER_CONFIRMED =
  "Đơn đã tạo — chuyển khoản theo hướng dẫn, admin duyệt xong gói sẽ vào hàng đợi.";
const QUEUE_CHANGED = "Danh sách gói đã thay đổi — đã tải lại";

/**
 * "Gói của tôi" (spec customer-portal "Plan queue page").
 *
 * Three sections, in the order a customer asks the questions: what do I have
 * (Gói của bạn: the paying queue on "Đang hoạt động", spent or closed plans on
 * "Không hoạt động"), what can I buy (Mua thêm gói), what did I order (Đơn hàng).
 *
 * The queue is reorderable and every number on a card comes from the server —
 * `statusLabel` and the window state are computed by queueViewSync, the same
 * function admission uses, so the page can never claim a plan is paying when the
 * request path would skip it.
 */
export default function PlansPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // `?plan=<code>` is the deep link the landing page sends after signup
  // ("Chọn Go" → register → verify → here). The card is highlighted and scrolled to.
  const highlightCode = (searchParams.get("plan") || "").toLowerCase();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [data, setData] = useState({ availableNanoUsd: 0, debtNanoUsd: 0, queue: [], history: [], plans: [] });
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [buyingId, setBuyingId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState("active");
  const highlightRef = useRef(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/account/plans", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được gói của bạn");
      setData({
        availableNanoUsd: body.availableNanoUsd || 0,
        debtNanoUsd: body.debtNanoUsd || 0,
        queue: Array.isArray(body.queue) ? body.queue : [],
        history: Array.isArray(body.history) ? body.history : [],
        plans: Array.isArray(body.plans) ? body.plans : [],
      });
    } catch (e) {
      setLoadError(e.message || "Không tải được gói của bạn");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const res = await fetch("/api/account/orders", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được đơn hàng");
      setOrders(Array.isArray(body.orders) ? body.orders : []);
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Không tải được đơn hàng" });
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadOrders();
  }, [load, loadOrders]);

  // Scroll the deep-linked plan card into view once, after it renders.
  useEffect(() => {
    if (!highlightCode || loading) return;
    const node = highlightRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightCode, loading]);

  const saveOrder = async (orderedIds) => {
    setSavingOrder(true);
    setQueueError("");
    setNotice(null);
    try {
      const res = await fetch("/api/account/plans/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409) {
        setQueueError(QUEUE_CHANGED);
        await load();
        return false;
      }
      if (!res.ok) {
        setQueueError(body?.error?.message || body?.error || "Không lưu được thứ tự");
        return false;
      }

      setData((current) => ({ ...current, queue: Array.isArray(body.queue) ? body.queue : current.queue }));
      setNotice({ type: "success", message: "Đã lưu thứ tự gói" });
      return true;
    } catch (e) {
      setQueueError(e.message || "Không lưu được thứ tự");
      return false;
    } finally {
      setSavingOrder(false);
    }
  };

  /**
   * Create an order for one offered method (spec payment-checkout "Creating a
   * gateway order"). A gateway order navigates straight to its payment page: the
   * customer needs the QR, and leaving them on the shop after picking "VietQR"
   * would hide the thing they must scan.
   */
  const buy = async (plan, method = "manual") => {
    setBuyingId(`${plan.id}:${method}`);
    setNotice(null);
    try {
      const res = await fetch("/api/account/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, method }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tạo được đơn hàng");

      if (method === "manual") {
        setNotice({ type: "success", message: ORDER_CONFIRMED });
        await loadOrders();
        return;
      }

      const target = body.url || `/account/orders/${body.order?.id}`;
      router.push(target);
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Không tạo được đơn hàng" });
    } finally {
      setBuyingId(null);
    }
  };

  const cancel = async (order) => {
    setCancellingId(order.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/account/orders/${order.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không hủy được đơn");
      setNotice({ type: "success", message: "Đã hủy đơn" });
      await loadOrders();
    } catch (e) {
      setNotice({ type: "error", message: e.message || "Không hủy được đơn" });
    } finally {
      setCancellingId(null);
    }
  };

  const highlightedPlan = useMemo(
    () => (highlightCode ? data.plans.find((plan) => String(plan.code).toLowerCase() === highlightCode) ?? null : null),
    [highlightCode, data.plans]
  );

  return (
    <Page
      title="Gói của tôi"
      description="Mỗi gói là một khoản credit dùng chung cho mọi model trong nhóm của bạn. Request trừ vào gói đầu tiên còn credit và chưa chạm hạn mức; đổi thứ tự bên dưới để quyết định gói nào trả trước."
    >
      {loadError && (
        <div role="alert" className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-5 py-4">
          <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden="true">error</span>
          <p className="flex-1 text-sm text-danger">{loadError}</p>
          <ActionButton size="sm" onClick={() => { setLoading(true); load(); }}>Thử lại</ActionButton>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`flex items-start gap-2 border px-5 py-4 ${
            notice.type === "error"
              ? "border-danger/40 bg-danger/5 text-danger"
              : "border-brand-500/40 bg-brand-500/5 text-brand-700 dark:text-brand-400"
          }`}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            {notice.type === "error" ? "error" : "check_circle"}
          </span>
          <p className="flex-1 text-sm">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Đóng thông báo"
            className="opacity-70 hover:opacity-100"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
          </button>
        </div>
      )}

      <div className={`grid gap-px border border-border bg-border ${data.debtNanoUsd > 0 ? "sm:grid-cols-2" : ""}`}>
        <div className="bg-surface p-6">
          <Stat
            label="Credit khả dụng"
            value={loading ? "…" : fmtUsdNano(data.availableNanoUsd)}
            hint="Tổng credit còn lại của các gói chưa hết hạn."
          />
        </div>
        {data.debtNanoUsd > 0 && (
          <div className="bg-surface p-6">
            <Stat
              label="Đang nợ"
              value={fmtUsdNano(data.debtNanoUsd)}
              hint="Khoản này được trừ vào credit của gói tiếp theo bạn nhận."
            />
          </div>
        )}
      </div>

      <Section
        title="Gói của bạn"
        description="Gói đang hoạt động trả tiền theo thứ tự trong hàng đợi. Gói hết credit, hết hạn, bị hủy hoặc đã hoàn tiền nằm ở tab Không hoạt động."
      >
        <PlanTabs
          tab={tab}
          onTab={setTab}
          counts={{ active: data.queue.length, inactive: data.history.length }}
        />
        <div role="tabpanel" id={`plans-panel-${tab}`} aria-labelledby={`plans-tab-${tab}`} className="mt-4">
          {tab === "active" ? (
            loading ? (
              <CardSkeleton />
            ) : (
              <PlanQueue
                entries={data.queue}
                editable={data.queue.length > 1}
                onSave={saveOrder}
                saving={savingOrder}
                error={queueError}
              />
            )
          ) : (
            <PlanHistory history={data.history} loading={loading} />
          )}
        </div>
      </Section>

      <BuyPlans
        plans={data.plans}
        loading={loading}
        buyingId={buyingId}
        onBuy={buy}
        highlightCode={highlightCode}
        highlightRef={highlightRef}
      />

      <MyOrders orders={orders} loading={ordersLoading} cancellingId={cancellingId} onCancel={cancel} />

      {highlightedPlan && !loading && (
        <p className="sr-only" aria-live="polite">
          Đã mở gói {highlightedPlan.name || highlightedPlan.code}
        </p>
      )}
    </Page>
  );
}
