import StatsClient from "./StatsClient";

export const metadata = {
  title: "Thống kê - derouter",
};

/** `/dashboard/stats`: token usage by time, model, provider and customer (change usage-analytics). */
export default function StatsPage() {
  return <StatsClient />;
}
