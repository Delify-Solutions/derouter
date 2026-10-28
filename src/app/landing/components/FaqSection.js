import PropTypes from "prop-types";
import { PLANS, USAGE_WINDOWS, fmtUsd } from "./salesData";

// FAQ ngắn: chỉ trả lời những câu mà cơ chế trong repo thực sự quyết định, để
// trang không hứa điều hệ thống không làm.
export default function FaqSection({ models, copy }) {
  const questions = [
    {
      q: "Hạn mức tính theo số request hay theo token?",
      a: "Theo chi phí. Mỗi model có một hạn mức tháng bằng USD trong bảng giá; mỗi request trừ vào hạn mức đó theo lượng token vào, ra và cached nhân với giá token của model. Request dài tốn nhiều hơn request ngắn.",
    },
    {
      q: "Ba cửa sổ hoạt động thế nào?",
      a: `Cả ba cùng được kiểm tra trên mọi request. Với một model có hạn mức tháng là X, bạn được dùng tối đa ${Math.round(
        USAGE_WINDOWS[0].fraction * 100
      )}% của X trong 5 giờ, ${Math.round(
        USAGE_WINDOWS[1].fraction * 100
      )}% trong 1 tuần và 100% trong 1 tháng. Cửa sổ ngắn không cộng dồn vào cửa sổ dài — chúng chặn song song.`,
    },
    {
      q: "Go Plus mở thêm model nào?",
      a: `Không. Cả hai gói mở cùng ${models.length} model. Go Plus chỉ nâng hạn mức mỗi model lên ${PLANS[1].limitMultiplier} lần, phù hợp khi agent chạy liên tục.`,
    },
    {
      q: "Dùng hết hạn mức thì sao?",
      a: "Request bị từ chối với 429 và header Retry-After chỉ ra thời điểm cửa sổ đang chặn nạp lại. Gọi model khác vẫn được nếu model đó còn hạn mức, vì mỗi model có hạn mức riêng.",
    },
    {
      q: "Gói thuê bao có thay thế số dư credit không?",
      a: "Không. Gói cấp hạn mức theo từng model trong thời hạn của gói. Số dư credit vẫn là nguồn trả tiền cho lưu lượng không thuộc gói.",
    },
    {
      q: "Có cần đổi code client không?",
      a: "Chỉ cần đổi base URL và API Key. Giao thức vẫn là OpenAI chat completions, nên SDK và công cụ hiện có chạy nguyên xi.",
    },
  ];

  return (
    <section id="faq" className="border-b border-border">
      <div className="shell py-20">
        <p className="meta text-text-muted">{copy.faqEyebrow}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          {copy.faqTitle}
        </h2>
        {copy.faqSubtitle ? (
          <p className="mt-3 max-w-2xl text-text-muted">{copy.faqSubtitle}</p>
        ) : null}

        <dl className="mt-10 grid grid-cols-1 gap-px border border-border bg-border lg:grid-cols-2">
          {questions.map((item) => (
            <div key={item.q} className="bg-surface p-6">
              <dt className="text-base font-semibold text-text-main">{item.q}</dt>
              <dd className="mt-2 text-sm text-text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 font-mono text-[11px] text-text-subtle">
          {PLANS.map((plan) => `${plan.name} ${fmtUsd(plan.priceUsd)}/tháng`).join(" · ")}
        </p>
      </div>
    </section>
  );
}

FaqSection.propTypes = {
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
