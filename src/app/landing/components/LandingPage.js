import { cookies } from "next/headers";
import Navigation from "./Navigation";
import AnnouncementBanner from "./AnnouncementBanner";
import HeroSection from "./HeroSection";
import PlansSection from "./PlansSection";
import ModelsSection from "./ModelsSection";
import PricingSection from "./PricingSection";
import GetStarted from "./GetStarted";
import FaqSection from "./FaqSection";
import Footer from "./Footer";
import { MODELS } from "./modelCatalog";
import { toSalesPlan } from "./salesData";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { listPlans } from "@/lib/db/repos/billingRepo.js";
import { listPlanModelLimits } from "@/lib/db/repos/planLimitsRepo.js";

/**
 * The landing page renders for everyone. It is the customer-facing shop, so the
 * only session it knows about is the customer one — an operator reaches the
 * dashboard at /dashboard and is never offered a shortcut here.
 *
 * Plans are read from the database, not hardcoded. The page used to ship two
 * fixed Go/Go Plus cards, so editing a plan in /dashboard/plans changed nothing
 * here — the two screens could contradict each other. Now a plan appears here
 * because it is active in the admin list, its price and duration come from the
 * plan row, and its per-model limits come from planModelLimits.
 *
 * The model catalogue still comes from the router's provider registry: it is a
 * statement about what the proxy can actually reach, not a marketing number.
 */
export default async function LandingPage({ copy }) {
  const cookieStore = await cookies();

  // The landing page is the customer-facing shop. It deliberately does not look
  // at the admin session at all: an operator browses to /dashboard directly, and
  // showing them an admin shortcut here would put an operator control on a page
  // that exists to sell to customers. Only "is there a customer session" matters,
  // and only so the nav can offer the account link instead of "log in".
  let session = null;
  const token = cookieStore.get(USER_COOKIE)?.value;
  if (token && (await verifyUserToken(token))) session = "customer";

  // Only visible plans: an admin can keep a plan as a draft by clearing
  // isActive, and it must not leak onto the public page.
  const planRows = await listPlans({ onlyActive: true });

  const plans = await Promise.all(
    planRows.map(async (row) => {
      const limits = await listPlanModelLimits(row.id);
      return toSalesPlan(row, limits);
    })
  );

  // A plan that sells models but has no catalogue entries would render an empty
  // price table; keep only the plans that are actually backed by limits, plus any
  // plan with no per-model limits (a flat-credit plan legs into that shape).
  const visiblePlans = plans.filter((p) => p.modelCount > 0 || p.creditUsd > 0);
  const featured = visiblePlans.find((p) => p.highlighted) ?? null;

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation session={session} />

      <main>
        <AnnouncementBanner
          text={copy.bannerText}
          href={copy.bannerHref}
          enabled={copy.bannerEnabled}
        />
        <HeroSection models={MODELS} plans={visiblePlans} copy={copy} />
        <PlansSection plans={visiblePlans} models={MODELS} copy={copy} />
        <ModelsSection models={MODELS} copy={copy} />
        <PricingSection plans={visiblePlans} models={MODELS} copy={copy} />
        <GetStarted models={MODELS} plans={visiblePlans} text={copy} />
        <FaqSection plans={visiblePlans} models={MODELS} copy={copy} />
      </main>

      <Footer modelCount={MODELS.length} plans={visiblePlans} featured={featured} />
    </div>
  );
}
