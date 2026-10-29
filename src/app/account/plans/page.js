import { Suspense } from "react";
import PlansPageClient from "./components/PlansPageClient";

export const metadata = {
  title: "Gói của tôi - derouter",
};

// useSearchParams (?plan=<code> deep link) suspends during pre-rendering.
export default function AccountPlansPage() {
  return (
    <Suspense fallback={<div className="h-40 border border-border bg-surface" />}>
      <PlansPageClient />
    </Suspense>
  );
}
