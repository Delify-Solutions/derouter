import { Page } from "@/app/account/components/ui";
import CacheRefundsTable from "./CacheRefundsTable";

export const metadata = {
  title: "Hoàn tiền cache - derouter",
};

export const dynamic = "force-dynamic";

// Spec cache-miss-refund "Customer visibility": the customer's own cache-miss
// refunds, newest first, each with the fixed generic reason — never the internal
// cause. Each one also appears on /account/ledger as a "Hoàn credit" row.
export default function CacheRefundsPage() {
  return (
    <Page
      title="Hoàn tiền cache"
      description="Khi một yêu cầu đáng lẽ dùng được cache nhưng hệ thống không dùng được, phần bạn trả thêm cho lần đó sẽ được hoàn lại vào cuối mỗi ngày. Mỗi khoản hoàn cũng xuất hiện ở Nhật ký credit."
    >
      <CacheRefundsTable />
    </Page>
  );
}
