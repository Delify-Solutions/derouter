import VerifyEmailClient from "./components/VerifyEmailClient";
import { safeNext } from "@/shared/utils/safeNext";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ searchParams }) {
  // A verification link must work even while another session is active — someone
  // confirming a second address should not be bounced away from the token.
  const params = await searchParams;
  const verifyToken = typeof params?.token === "string" ? params.token : "";
  // `next` came from the mail; it is validated server-side so the login link this
  // page offers can carry it safely (design D17).
  const next = safeNext(typeof params?.next === "string" ? params.next : null);
  return <VerifyEmailClient token={verifyToken} next={next} />;
}
