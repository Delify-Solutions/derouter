import { Suspense } from "react";
import UsersPageClient from "./UsersPageClient";

// useSearchParams (the `?groupId=` filter) suspends during pre-rendering, so the
// client tree needs a boundary; the fallback matches the page's own skeleton.
export default function UsersPage() {
  return (
    <Suspense fallback={<div className="h-40 border border-border bg-surface" />}>
      <UsersPageClient />
    </Suspense>
  );
}
