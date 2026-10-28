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
//
// `preview` bật một dải nhắc ở đầu trang khi admin đang xem bằng ?preview=1,
// để không nhầm đây là trang thật của khách.
export default function LandingPage({ copy, preview = false }) {
  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      {preview ? (
        <div className="border-b border-border bg-brand-500/10 px-4 py-2 text-center font-mono text-[11px] text-brand-700 dark:text-brand-400">
          Đang xem trước với tư cách admin ·{" "}
          <a href="/dashboard" className="underline">về bảng điều khiển</a>
        </div>
      ) : null}

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
