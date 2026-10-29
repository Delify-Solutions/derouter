import { Suspense } from "react";
import UserDetailClient from "./UserDetailClient";

export const metadata = { title: "Người dùng - derouter" };

// useSearchParams (the `?tab=` selector) suspends during pre-rendering.
export default function UserDetailPage() {
  return (
    <Suspense fallback={<div className="h-40 border border-border bg-surface" />}>
      <UserDetailClient />
    </Suspense>
  );
}
