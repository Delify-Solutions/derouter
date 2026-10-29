import { Suspense } from "react";
import LoginForm from "./components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }) {
  // No redirect for an already-signed-in visitor: the form stays reachable, which
  // is what lets someone switch account or re-authenticate without logging out
  // first. Logging in simply replaces the cookie.
  const params = await searchParams;
  const resetToken = typeof params?.token === "string" ? params.token : "";

  // useSearchParams (?next=) needs a Suspense boundary during pre-rendering.
  return (
    <Suspense fallback={<div className="h-40" />}>
      <LoginForm resetToken={resetToken} />
    </Suspense>
  );
}
