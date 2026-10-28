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
import { MODELS, SAMPLE_MODEL } from "./modelCatalog";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { verifyUserToken } from "@/lib/auth/userSession";
import { USER_COOKIE } from "@/lib/auth/userSession";

/**
 * The landing page renders for everyone — the root route no longer redirects a
 * signed-in visitor onward. That makes the nav the single way into the app, so
 * the session is resolved here (server-side, where the cookies are) and passed
 * down as one of three states: null, "admin", "customer".
 *
 * Admin is checked first: an operator holding both cookies should land in the
 * shell, which is where their work is.
 *
 * Everything else — copy, prices, the model catalogue — is unchanged: copy comes
 * from settings.landingCopy (admin-editable), numbers from salesData.js and the
 * provider registry.
 *
 * Section order is a contract: banner → hero → plans → models → pricing →
 * get started → FAQ → footer.
 */
export default async function LandingPage({ copy }) {
  const cookieStore = await cookies();

  const adminSession = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
  let session = null;
  if (adminSession) {
    session = "admin";
  } else {
    const token = cookieStore.get(USER_COOKIE)?.value;
    if (token && (await verifyUserToken(token))) session = "customer";
  }

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation session={session} />

      <main>
        <AnnouncementBanner
          text={copy.bannerText}
          href={copy.bannerHref}
          enabled={copy.bannerEnabled}
        />
        <HeroSection models={MODELS} copy={copy} />
        <PlansSection models={MODELS} sampleModel={SAMPLE_MODEL} copy={copy} />
        <ModelsSection models={MODELS} copy={copy} />
        <PricingSection models={MODELS} copy={copy} />
        <GetStarted models={MODELS} text={copy} />
        <FaqSection models={MODELS} copy={copy} />
      </main>

      <Footer modelCount={MODELS.length} />
    </div>
  );
}
