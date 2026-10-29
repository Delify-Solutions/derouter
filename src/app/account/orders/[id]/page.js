import OrderPaymentClient from "./OrderPaymentClient";

export const metadata = {
  title: "Thanh toán đơn - derouter",
};

/**
 * `/account/orders/[id]` (spec payment-checkout "Order page").
 *
 * The id is passed through to the client, which loads it from
 * `GET /api/account/orders/[id]`: ownership is enforced there, and a customer
 * opening someone else's id gets the same not-found state as a nonexistent one.
 * Doing the check only in a server component would duplicate the rule.
 */
export default async function OrderPage({ params }) {
  const { id } = await params;
  return <OrderPaymentClient orderId={id} />;
}
