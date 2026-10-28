import VerifyEmailClient from "./components/VerifyEmailClient";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ searchParams }) {
  // A verification link must work even while another session is active — someone
  // confirming a second address should not be bounced away from the token.
  const params = await searchParams;
  const verifyToken = typeof params?.token === "string" ? params.token : "";
  return <VerifyEmailClient token={verifyToken} />;
}
