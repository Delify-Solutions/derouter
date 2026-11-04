import AffiliatePageClient from "./components/AffiliatePageClient";

export const metadata = {
  title: "Giới thiệu - derouter",
};

export const dynamic = "force-dynamic";

/** `/account/affiliate` — referral link, welcome gift, wallet, credit conversion and vouchers. */
export default function AffiliatePage() {
  return <AffiliatePageClient />;
}
