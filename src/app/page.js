import LandingPage from "./landing/components/LandingPage";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";

export const dynamic = "force-dynamic";

// The root layout carries an English default title for the dashboard; the public
// page is Vietnamese.
export const metadata = {
  title: "derouter - Gói AI dùng chung một credit",
  description: "Mua gói, nhận credit dùng chung cho mọi model lập trình và gọi qua một endpoint tương thích OpenAI và Claude.",
};

/**
 * `/` always renders the landing page, for everyone.
 *
 * It used to bounce a signed-in visitor onward — admin to /dashboard, customer
 * to /account — which made the page impossible to look at while editing it and
 * surprised anyone who followed a link to the site root. Navigation is now
 * explicit: the nav bar carries the way in, and the landing page is a page you
 * can actually visit.
 *
 * Access control did not move. /dashboard and /account still guard themselves;
 * nothing here decides who may see what.
 *
 * Copy is operator-editable, so it is read per request rather than baked into
 * the build — `dynamic` above is what keeps a saved edit visible on the next
 * load instead of after a redeploy.
 */
export default async function RootPage() {
  const settings = await getSettings();
  return <LandingPage copy={mergeLandingCopy(settings.landingCopy)} />;
}
