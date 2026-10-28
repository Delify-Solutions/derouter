import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import LoginForm from "./components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }) {
  // Strict check: a revoked or suspended session must land on the form, not bounce
  // between /account and /login.
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (session) redirect("/account");

  const params = await searchParams;
  const resetToken = typeof params?.token === "string" ? params.token : "";

  return <LoginForm resetToken={resetToken} />;
}
