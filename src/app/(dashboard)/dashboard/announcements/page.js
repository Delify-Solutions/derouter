import AnnouncementsClient from "./AnnouncementsClient";

export const metadata = {
  title: "Thông báo - derouter",
};

export const dynamic = "force-dynamic";

/** `/dashboard/announcements`: announcements customers read on /account/notifications. */
export default function AnnouncementsPage() {
  return <AnnouncementsClient />;
}
