import { Page } from "@/app/account/components/ui";
import LedgerTable from "./LedgerTable";

export const metadata = {
  title: "Sổ cái - derouter",
};

export const dynamic = "force-dynamic";

// Every credit movement of the signed-in customer: grants, charges, expiries and
// adjustments, with the request each charge paid for.
export default function AccountLedgerPage() {
  return (
    <Page
      title="Sổ cái"
      description="Mọi thay đổi credit của bạn, mới nhất trước. Dòng “Trừ tiền” ghi model và số token mà khoản đó đã trả."
    >
      <LedgerTable />
    </Page>
  );
}
