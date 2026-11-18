import { Page } from "../components/ui";
import StorageConfigPanel from "@/shared/components/StorageConfigPanel";

export const metadata = {
  title: "CDN ảnh - derouter",
};

export const dynamic = "force-dynamic";

/** `/account/storage` ("CDN ảnh"): the storage generated images are uploaded to (spec image-storage). */
export default function AccountStoragePage() {
  return (
    <Page
      title="CDN ảnh"
      description="Kết nối kho lưu trữ chuẩn S3 để dùng model tạo ảnh. Ảnh tạo xong được lưu vào kho của bạn và bạn nhận link từ kho đó."
    >
      <StorageConfigPanel apiBase="/api/account/storage" audience="customer" />
    </Page>
  );
}
