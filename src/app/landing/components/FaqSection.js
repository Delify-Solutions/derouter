import PropTypes from "prop-types";
import { fmtUsd } from "./salesData";

// FAQ ngắn: chỉ trả lời những câu mà cơ chế trong repo thực sự quyết định, để
// trang không hứa điều hệ thống không làm. Năm câu hỏi của spec public-landing:
// mua nhiều gói, hạn mức 5 giờ, credit còn lại khi hết hạn, model nào dùng được,
// và gói bị tạm khoá.
export default function FaqSection({ plans, models, copy }) {
  const questions = [
    {
      q: "Mua nhiều gói thì dùng thế nào?",
      a: "Mỗi gói là một khoản credit riêng, xếp thành hàng đợi. Request được trừ vào gói đầu tiên còn credit và chưa chạm hạn mức; khi gói đó tạm khoá, hệ thống tự chuyển sang gói kế tiếp. Bạn đổi được thứ tự trong trang Gói của tôi.",
    },
    {
      q: "Hạn mức 5 giờ nghĩa là gì?",
      a: "Lần đầu gói được trừ tiền, một cửa sổ 5 giờ mở ra. Trong 5 giờ đó bạn chỉ dùng tối đa mức tiền mà gói quy định cho cửa sổ này (ví dụ $20). Hết 5 giờ, cửa sổ đóng và lần trừ tiền tiếp theo mở cửa sổ mới, tính lại từ đầu.",
    },
    {
      q: "Credit còn lại khi gói hết hạn thì sao?",
      a: "Credit chưa dùng hết sẽ mất khi gói hết hạn — đó là lý do gói được xếp theo ngày hết hạn, để phần sắp hết hạn được dùng trước. Sổ cái của bạn ghi lại đúng phần credit bị mất.",
    },
    {
      q: "Tôi dùng được những model nào?",
      a: `Mọi model mà nhóm tài khoản của bạn cho phép — credit dùng chung cho tất cả, không chia theo model. Danh mục hiện có ${models.length} model; gọi model ngoài nhóm sẽ bị từ chối với lỗi 403.`,
    },
    {
      q: "Gói bị tạm khoá thì sao?",
      a: "Khi một cửa sổ đã dùng hết mức, gói đó tạm khoá cho tới khi cửa sổ đóng. Nếu còn gói khác trong hàng đợi, request vẫn chạy bình thường trên gói đó. Nếu tất cả đều khoá, bạn nhận lỗi 429 kèm thời điểm mở lại gần nhất.",
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
          {plans
            .map((plan) => `${plan.name} ${fmtUsd(plan.priceUsd)} → ${fmtUsd(plan.creditUsd)} trong ${plan.durationDays} ngày`)
            .join(" · ")}
        </p>
      </div>
    </section>
  );
}

FaqSection.propTypes = {
  plans: PropTypes.array.isRequired,
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
