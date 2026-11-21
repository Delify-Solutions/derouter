import { cookies } from "next/headers";
import Navigation from "@/app/landing/components/Navigation";
import Footer from "@/app/landing/components/Footer";
import { toSalesPlan } from "@/app/landing/components/salesData";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { listPlans } from "@/lib/db/repos/billingRepo.js";
import { offeredMethodsSync } from "@/lib/payments/checkout.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { termLabel } from "@/lib/billing/terms.js";
import BusinessHero from "./components/BusinessHero";
import BusinessPlansSection from "./components/BusinessPlansSection";
import { BusinessFeatures, BusinessHowItWorks, BusinessFaq, BusinessClosingCta } from "./components/BusinessSections";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "AI chatbot cho doanh nghiệp - derouter",
  description:
    "Chatbot trả lời từ tài liệu công ty, an toàn chủ quyền và đúng phạm vi doanh nghiệp. Mỗi bot một API riêng, tính phí như request thường.",
};

// The business page has its own anchors; the shared navigation gets them through
// `items`, so an anchor never points at a section this page does not render.
const NAV_ITEMS = [
  { href: "#features", label: "Tính năng" },
  { href: "#how-it-works", label: "Cách hoạt động" },
  { href: "#plans", label: "Bảng giá" },
  { href: "#faq", label: "Hỏi đáp" },
  { href: "/", label: "Trang chủ" },
];

/**
 * `/doanh-nghiep` — the sales page of the second product line (spec
 * business-landing). Only `business` plans are sold here; the API plans stay on
 * the main landing.
 */
export default async function BusinessLandingPage() {
  const cookieStore = await cookies();
  let signedIn = false;
  const token = cookieStore.get(USER_COOKIE)?.value;
  if (token && (await verifyUserToken(token))) signedIn = true;

  const rows = (await listPlans({ onlyActive: true })).filter((row) => row.productLine === "business");
  const db = await getAdapter();
  const settings = await getSettings();
  const plans = rows.map((row) => ({
    ...toSalesPlan(row, offeredMethodsSync(db, row, settings)),
    periodLabel: termLabel(row.durationDays, 1),
    maxBots: row.maxBots,
    maxKbBytes: row.maxKbBytes,
  }));

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation session={signedIn ? "customer" : null} items={NAV_ITEMS} />
      <main>
        <BusinessHero signedIn={signedIn} />
        <BusinessFeatures />
        <BusinessHowItWorks />
        <BusinessPlansSection plans={plans} signedIn={signedIn} />
        <BusinessFaq />
        <BusinessClosingCta signedIn={signedIn} />
      </main>
      <Footer modelCount={0} plans={plans} />
    </div>
  );
}
