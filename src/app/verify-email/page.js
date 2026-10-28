import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import VerifyEmailClient from "./components/VerifyEmailClient";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ searchParams }) {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (session) redirect("/account");

  const params = await searchParams;
  const verifyToken = typeof params?.token === "string" ? params.token : "";
  return <VerifyEmailClient token={verifyToken} />;
}
