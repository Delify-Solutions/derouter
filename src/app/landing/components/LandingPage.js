import Navigation from "./Navigation";
import AnnouncementBanner from "./AnnouncementBanner";
import HeroSection from "./HeroSection";
import PlansSection from "./PlansSection";
import ModelsSection from "./ModelsSection";
import PricingSection from "./PricingSection";
import GetStarted from "./GetStarted";
import FaqSection from "./FaqSection";
import Footer from "./Footer";
import { MODELS, SAMPLE_MODEL } from "./modelCatalog";

// Trang bán hàng của hai gói thuê bao Go / Go Plus. Được render từ
// src/app/page.js (server component) để root kịp chuyển phiên đang đăng nhập
// sang /dashboard hoặc /account trước khi markup này được tạo.
//
// Mọi câu chữ đến từ `copy` (admin sửa trong /dashboard/content); mọi con số đến
// từ salesData.js và registry của router. Nhờ vậy đổi lời không phải sửa JSX, và
// đổi giá không phải sửa lời.
//
// Thứ tự section là hợp đồng: banner → hero → so sánh gói → danh mục model →
// bảng giá chi tiết → cách dùng → FAQ → footer.
export default function LandingPage({ copy }) {
  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation />

      <main>
        <AnnouncementBanner
          text={copy.bannerText}
          href={copy.bannerHref}
          enabled={copy.bannerEnabled}
        />
        <HeroSection models={MODELS} copy={copy} />
        <PlansSection models={MODELS} sampleModel={SAMPLE_MODEL} copy={copy} />
        <ModelsSection models={MODELS} copy={copy} />
        <PricingSection models={MODELS} copy={copy} />
        <GetStarted models={MODELS} text={copy} />
        <FaqSection models={MODELS} copy={copy} />
      </main>

      <Footer modelCount={MODELS.length} />
    </div>
  );
}
