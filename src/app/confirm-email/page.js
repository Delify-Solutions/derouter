import ConfirmEmailClient from "./components/ConfirmEmailClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Xác nhận đổi email - derouter",
};

/**
 * `/confirm-email?token=` — the link mailed to the new address of an email
 * change (spec customer-portal "Change email by confirmation link"). Public: it
 * may be opened on a device that is not signed in.
 */
export default async function ConfirmEmailPage({ searchParams }) {
  const params = await searchParams;
  const token = typeof params?.token === "string" ? params.token : "";
  return <ConfirmEmailClient token={token} />;
}
