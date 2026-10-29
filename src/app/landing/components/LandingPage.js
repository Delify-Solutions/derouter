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
import { buildModelListForGroup } from "./modelCatalog";
import { toSalesPlan } from "./salesData";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { listPlans } from "@/lib/db/repos/billingRepo.js";
import { offeredMethodsSync } from "@/lib/payments/checkout.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

/**
 * The landing page renders for everyone. It is the customer-facing shop, so the
 * only session it knows about is the customer one — an operator reaches the
 * dashboard at /dashboard and is never offered a shortcut here.
 *
 * Plans are read from the database, not hardcoded. The page used to ship two
 * fixed Go/Go Plus cards, so editing a plan in /dashboard/plans changed nothing
 * here — the two screens could contradict each other. Now a plan appears here
 * because it is active in the admin list, and its price, credit, duration and
 * per-window limits all come from the plan row.
 *
 * The model catalogue is the default customer group's allow-list priced from the
 * router's own token rates: the page states what a registered customer can call, and
 * at what price, not what the proxy happens to be able to reach.
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

  // The model list is what a NEWLY REGISTERED customer can actually call: the
  // default group's allow-list (spec public-landing "Sellable models"). Advertising
  // the whole registry would promise models the group will 403 on.
  const MODELS = await buildModelListForGroup();

  // Which methods each plan actually offers decides what its card advertises: a
  // plan with no price or no receiving account must say "Chưa mở bán" instead of
  // inviting a customer to buy something they cannot pay for.
  const db = await getAdapter();
  const settings = await getSettings();
  const plans = planRows.map((row) =>
    toSalesPlan(row, offeredMethodsSync(db, row, settings))
  );

  // A plan with no credit grants nothing; it has no card worth showing.
  const visiblePlans = plans.filter((p) => p.creditUsd > 0);
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
        <PlansSection plans={visiblePlans} models={MODELS} copy={copy} signedIn={session === "customer"} />
        <ModelsSection models={MODELS} copy={copy} />
        <PricingSection plans={visiblePlans} models={MODELS} copy={copy} />
        <GetStarted models={MODELS} plans={visiblePlans} text={copy} />
        <FaqSection plans={visiblePlans} models={MODELS} copy={copy} />
      </main>

      <Footer modelCount={MODELS.length} plans={visiblePlans} featured={featured} />
    </div>
  );
}
