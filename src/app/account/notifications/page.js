import NotificationsClient from "./components/NotificationsClient";

export const metadata = {
  title: "Thông báo - derouter",
};

export const dynamic = "force-dynamic";

/** `/account/notifications` ("Thông báo"): announcements, own notifications, Telegram. */
export default function AccountNotificationsPage() {
  return <NotificationsClient />;
}
