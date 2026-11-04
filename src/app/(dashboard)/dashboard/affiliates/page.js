import AffiliatesPageClient from "./AffiliatesPageClient";

export const metadata = {
  title: "Affiliate - derouter",
};

export const dynamic = "force-dynamic";

/**
 * `/dashboard/affiliates` — program settings, CTVs, commissions and vouchers.
 * `?tab=affiliates&q=<code>` opens the CTV list filtered to one affiliate (the
 * user detail page links here).
 */
export default async function AffiliatesPage({ searchParams }) {
  const params = await searchParams;
  const tab = typeof params?.tab === "string" ? params.tab : "";
  const q = typeof params?.q === "string" ? params.q.slice(0, 100) : "";
  return <AffiliatesPageClient initialTab={tab} initialQuery={q} />;
}
