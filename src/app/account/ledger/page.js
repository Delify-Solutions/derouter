import { Page } from "@/app/account/components/ui";
import LedgerTable from "./LedgerTable";

export const metadata = {
  title: "Nhật ký credit - derouter",
};

export const dynamic = "force-dynamic";

// Every credit movement of the signed-in customer: grants, charges, expiries and
// adjustments, with the request each charge paid for.
export default function AccountLedgerPage() {
  return (
    <Page
      title="Nhật ký credit"
      description="Mỗi lần credit của bạn được cấp, bị trừ, hết hạn hay điều chỉnh đều ghi ở đây, mới nhất trước. Dòng “Trừ credit” cho biết model và số token mà khoản đó đã trả."
    >
      <LedgerTable />
    </Page>
  );
}
