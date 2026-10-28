import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import RegisterForm from "./components/RegisterForm";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (session) redirect("/account");
  return <RegisterForm />;
}
