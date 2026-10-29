import PropTypes from "prop-types";
import { FORMAT_LABELS, interpolate } from "./salesData";

export default function ModelsSection({ models, copy }) {
  return (
    <section id="models" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <p className="meta text-text-muted">{copy.modelsEyebrow}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
          {interpolate(copy.modelsTitle, { count: models.length })}
        </h2>
        {copy.modelsSubtitle ? (
          <p className="mt-3 max-w-2xl text-text-muted">{copy.modelsSubtitle}</p>
        ) : null}
        <p className="mt-3 max-w-2xl text-text-muted">
          Danh sách này đọc thẳng từ registry của router, nên model nào hiện ở đây là model gọi
          được ngay. Nhãn bên dưới cho biết wire format mà model đó nhận.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {models.map((model) => (
            <div key={model.id} className="bg-surface p-5">
              <h3 className="text-base font-semibold">{model.name}</h3>
              <p className="mt-1 break-all font-mono text-[12px] text-text-subtle">{model.id}</p>

              <ul className="mt-4 flex flex-wrap gap-1.5">
                {model.formats.map((format) => (
                  <li
                    key={format}
                    className="border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-muted"
                  >
                    {FORMAT_LABELS[format] || format}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-4 font-mono text-[11px] text-text-subtle">
          Credit của gói bị trừ theo giá token của từng model, nên model đắt dùng credit nhanh
          hơn. Giá cụ thể ở bảng bên dưới.
        </p>
      </div>
    </section>
  );
}

ModelsSection.propTypes = {
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
