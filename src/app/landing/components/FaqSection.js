import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
import { fmtUsd } from "./salesData";

// FAQ ngắn: chỉ trả lời những câu mà cơ chế trong repo thực sự quyết định, để
// trang không hứa điều hệ thống không làm. Năm câu hỏi của spec public-landing:
// mua nhiều gói, hạn mức 5 giờ, credit còn lại khi hết hạn, model nào dùng được,
// và gói bị tạm khóa.
export default function FaqSection({ plans, models, copy }) {
  const questions = [
    {
      q: "Mua nhiều gói thì dùng thế nào?",
      a: "Mỗi gói có credit, thời hạn và hạn mức riêng, và các gói xếp thành hàng đợi. Request trừ vào gói đầu hàng đợi còn credit và chưa chạm hạn mức; khi gói đó tạm khóa, request chuyển sang gói kế tiếp. Mặc định gói sắp hết hạn được dùng trước, và bạn đổi được thứ tự trong mục Gói của tôi.",
    },
    {
      q: "Hạn mức 5 giờ nghĩa là gì?",
      a: "Khung 5 giờ bắt đầu từ lần đầu gói bị trừ credit. Trong khung này, gói chỉ cho dùng tối đa số tiền đã quy định (ví dụ $20). Hết 5 giờ, hạn mức mở lại đầy đủ và lần trừ credit kế tiếp bắt đầu một khung mới.",
    },
    {
      q: "Credit còn lại khi gói hết hạn thì sao?",
      a: "Credit chưa dùng sẽ mất khi gói hết hạn. Vì vậy mặc định gói sắp hết hạn được dùng trước. Phần credit bị mất được ghi trong Nhật ký credit của tài khoản.",
    },
    {
      q: "Tôi dùng được những model nào?",
      a: `Mọi model mà nhóm của bạn cho phép. Credit dùng chung cho tất cả model, không chia theo từng model. Danh mục hiện có ${models.length} model; gọi model ngoài nhóm sẽ nhận lỗi 403.`,
    },
    {
      q: "Gói bị tạm khóa thì sao?",
      a: "Khi đã dùng hết mức của một khung giờ, gói đó tạm khóa đến khi khung giờ kết thúc. Nếu hàng đợi còn gói khác, request chạy tiếp trên gói đó. Nếu mọi gói đều bị khóa, bạn nhận lỗi 429 kèm thời điểm mở lại gần nhất.",
    },
  ];

  return (
    <section id="faq" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow={copy.faqEyebrow} title={copy.faqTitle}>
          {copy.faqSubtitle ? <p>{copy.faqSubtitle}</p> : null}
        </SectionHeader>

        {/* Native <details>: keyboard-operable with no state, and the answers stay
            in the page for anyone who reads without scripts. */}
        <div className="mt-12 flex max-w-3xl flex-col border border-border bg-surface">
          {questions.map((item, index) => (
            <details key={item.q} className={`group ${index > 0 ? "border-t border-border" : ""}`}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-base font-semibold text-text-main hover:bg-surface-2">
                {item.q}
                <span
                  className="material-symbols-outlined text-[20px] text-text-muted transition-transform duration-150 group-open:rotate-180"
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </summary>
              <p className="px-6 pb-6 text-sm leading-7 text-text-muted">{item.a}</p>
            </details>
          ))}
        </div>

        {plans.length > 0 && (
          <p className="mt-6 font-mono text-xs text-text-subtle">
            {plans
              .map((plan) => `${plan.name}: ${fmtUsd(plan.priceUsd)} nhận ${plan.unlimitedCredit ? "credit không giới hạn" : `${fmtUsd(plan.creditUsd)} credit`}, dùng ${plan.durationDays} ngày`)
              .join(" · ")}
          </p>
        )}
      </div>
    </section>
  );
}

FaqSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
