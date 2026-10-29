import { Suspense } from "react";
import RegisterForm from "./components/RegisterForm";

export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }) {
  // Reachable while signed in: signing up for a second account is a legitimate
  // action and does not require logging out first.
  //
  // The form reads `?next=` itself through useSearchParams, which is why the
  // Suspense boundary below is required during pre-rendering; `searchParams` is
  // awaited here only so the page stays dynamic.
  await searchParams;
  return (
    <Suspense fallback={<div className="h-40" />}>
      <RegisterForm />
    </Suspense>
  );
}
