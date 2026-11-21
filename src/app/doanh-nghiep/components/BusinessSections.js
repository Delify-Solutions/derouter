import Link from "next/link";
import PropTypes from "prop-types";
import SectionHeader from "@/app/landing/components/SectionHeader";

const FEATURES = [
  {
    icon: "flag",
    title: "An toàn chủ quyền",
    body: "Câu hỏi về Hoàng Sa, Trường Sa và Biển Đông luôn nhận câu trả lời theo quan điểm chính thức của Việt Nam, rồi được hướng về sản phẩm của bạn.",
  },
  {
    icon: "shield",
    title: "Đúng phạm vi doanh nghiệp",
    body: "Mỗi bot có một mô tả lĩnh vực. Câu hỏi ngoài phạm vi nhận đúng câu từ chối bạn đặt, còn nội dung chính trị bị chặn.",
  },
  {
    icon: "folder",
    title: "Học từ dữ liệu công ty",
    body: "Tải PDF, DOCX, TXT, MD hoặc dán văn bản và cặp hỏi đáp. Bot chỉ dùng những đoạn liên quan nhất trong câu trả lời.",
  },
  {
    icon: "key",
    title: "API riêng cho từng bot",
    body: "Mỗi bot có key riêng, gọi đúng một model doanh nghiệp qua endpoint /v1/chat/completions, tính phí như request thường.",
  },
];

const STEPS = [
  { number: "01", title: "Tạo bot", body: "Đặt tên, tên doanh nghiệp và mô tả lĩnh vực mà bot được phép trả lời." },
  { number: "02", title: "Tải tài liệu", body: "Thêm tài liệu công ty. Hệ thống cắt đoạn và tạo embedding ngay sau khi tải lên." },
  { number: "03", title: "Tạo API key", body: "Mỗi bot có danh sách key riêng; key hiện một lần khi tạo và xem lại được trong mục Key API." },
  { number: "04", title: "Kết nối ứng dụng", body: "Trỏ website hoặc ứng dụng của bạn vào endpoint với key của bot." },
];

const FAQ = [
  {
    q: "Dữ liệu nào được lưu?",
    a: "Chỉ phần văn bản trích xuất từ tài liệu, chia thành các đoạn để tìm kiếm. Tệp gốc không được lưu lại. Câu hỏi bị chặn được ghi kèm 200 ký tự đầu để bạn xem lại và điều chỉnh mô tả lĩnh vực.",
  },
  {
    q: "Câu hỏi ngoài phạm vi thì sao?",
    a: "Bot trả lời đúng câu từ chối bạn đặt cho bot. Câu hỏi được ghi vào mục Câu hỏi bị chặn để bạn thấy khách đang hỏi gì.",
  },
  {
    q: "Câu hỏi về chủ quyền được xử lý thế nào?",
    a: "Hệ thống nhận diện trước bằng từ khoá, rồi trả lời theo nội dung quan điểm chính thức do quản trị viên đặt, sau đó hướng khách về sản phẩm của doanh nghiệp.",
  },
  {
    q: "Hỗ trợ những loại tệp nào?",
    a: "PDF, DOCX, TXT và MD, tối đa 10 MB mỗi tệp, cộng với văn bản dán trực tiếp và cặp hỏi đáp. Tệp PDF chỉ có ảnh scan sẽ báo lỗi vì không đọc được chữ.",
  },
  {
    q: "Gói hết hạn thì sao?",
    a: "Bot và tài liệu vẫn được giữ và vẫn xem được, nhưng bạn không tạo thêm bot hoặc thêm tài liệu được cho tới khi gia hạn. Gói API không trả cho key của chatbot, và ngược lại.",
  },
];

export function BusinessFeatures() {
  return (
    <section id="features" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <SectionHeader eyebrow="Vì sao" title="Một chatbot bạn dám đặt trước khách hàng" />
        <ul className="mt-12 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex flex-col gap-3 bg-surface p-6">
              <span className="material-symbols-outlined text-[22px] text-text-main" aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className="text-base font-semibold text-text-main">{feature.title}</h3>
              <p className="text-sm leading-6 text-text-muted">{feature.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function BusinessHowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-border">
      <div className="shell py-20">
        <SectionHeader eyebrow="Cách hoạt động" title="Bốn bước từ tài liệu đến câu trả lời" />
        <ol className="mt-12 grid grid-cols-1 gap-px border border-border bg-border md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <li key={step.number} className="flex flex-col gap-2 bg-surface p-6">
              <span className="font-mono text-[11px] text-text-subtle">[{step.number}]</span>
              <h3 className="text-base font-semibold text-text-main">{step.title}</h3>
              <p className="text-sm leading-6 text-text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function BusinessFaq() {
  return (
    <section id="faq" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <SectionHeader eyebrow="Hỏi đáp" title="Câu hỏi thường gặp" />
        {/* Native <details>: keyboard-operable, no state, readable without scripts. */}
        <div className="mt-12 flex max-w-3xl flex-col border border-border bg-surface">
          {FAQ.map((item, index) => (
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
      </div>
    </section>
  );
}

export function BusinessClosingCta({ signedIn = false }) {
  const href = signedIn ? "/account/business" : "/register?next=/account/business";
  return (
    <section className="border-b border-border">
      <div className="shell py-20">
        <div className="flex flex-col items-start justify-between gap-6 border border-border bg-surface p-8 md:flex-row md:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-text-main">Đưa chatbot vào website của bạn</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
              Tạo bot, tải tài liệu và lấy key trong vài phút. Không cần huấn luyện lại model.
            </p>
          </div>
          <Link
            href={href}
            className="inline-flex h-12 shrink-0 items-center justify-center border border-text-main bg-text-main px-7 font-mono text-sm font-medium text-bg transition-colors duration-150 hover:bg-text-main/85"
          >
            Tạo chatbot
          </Link>
        </div>
      </div>
    </section>
  );
}

BusinessClosingCta.propTypes = {
  signedIn: PropTypes.bool,
};
