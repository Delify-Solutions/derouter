import StorageAdminClient from "./StorageAdminClient";

export const metadata = {
  title: "CDN ảnh - derouter",
};

export const dynamic = "force-dynamic";

/** `/dashboard/storage`: the system image storage and every customer's (spec image-storage). */
export default function StorageAdminPage() {
  return <StorageAdminClient />;
}
