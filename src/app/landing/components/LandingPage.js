import Navigation from "./Navigation";
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
// Component này là server component: danh mục model và giá token được dựng một
// lần ở đây (modelCatalog.js đọc registry của router), rồi truyền xuống các
// section. Chỉ những section có tương tác mới là client component.
//
// Thứ tự section là hợp đồng: hero → so sánh gói → danh mục model → bảng giá
// chi tiết → cách dùng → FAQ → footer.
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation />

      <main>
        <HeroSection models={MODELS} />
        <PlansSection models={MODELS} sampleModel={SAMPLE_MODEL} />
        <ModelsSection models={MODELS} />
        <PricingSection models={MODELS} />
        <GetStarted models={MODELS} />
        <FaqSection models={MODELS} />
      </main>

      <Footer modelCount={MODELS.length} />
    </div>
  );
}
