import RegisterForm from "./components/RegisterForm";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  // Reachable while signed in: signing up for a second account is a legitimate
  // action and does not require logging out first.
  return <RegisterForm />;
}
