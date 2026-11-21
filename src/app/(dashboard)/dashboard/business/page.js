import BusinessSettingsClient from "./BusinessSettingsClient";

export const metadata = {
  title: "AI doanh nghiệp - derouter",
};

export const dynamic = "force-dynamic";

export default function AdminBusinessPage() {
  return <BusinessSettingsClient />;
}
