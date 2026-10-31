import PropTypes from "prop-types";
import SectionHeader from "./SectionHeader";
import { FORMAT_LABELS, interpolate } from "./salesData";

// The catalogue can hold hundreds of models (a group with no allow-list allows
// every chat model), so this section shows a sample and sends the reader to the
// searchable price table for the rest. Printing all of them made the page tens of
// thousands of pixels tall.
const SAMPLE = 12;

export default function ModelsSection({ models, copy }) {
  const sample = models.slice(0, SAMPLE);
  const rest = Math.max(0, models.length - sample.length);

  return (
    <section id="models" className="border-b border-border bg-bg-alt">
      <div className="shell py-20">
        <SectionHeader eyebrow={copy.modelsEyebrow} title={interpolate(copy.modelsTitle, { count: models.length })}>
          {copy.modelsSubtitle ? <p>{copy.modelsSubtitle}</p> : null}
          <p>
            Đây là các model tài khoản mới gọi được, theo đúng tên bạn gửi trong trường model.
          </p>
        </SectionHeader>

        <div className="mt-12 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {sample.map((model) => (
            <div key={model.id} className="flex flex-col gap-3 bg-surface p-5">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-text-main" title={model.name}>{model.name}</h3>
                <p className="mt-1 break-all font-mono text-xs text-text-subtle">{model.id}</p>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {model.formats.map((format) => (
                  <li
                    key={format}
                    className="border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted"
                  >
                    {FORMAT_LABELS[format] || format}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {rest > 0 ? (
          <p className="mt-4 text-sm text-text-muted">
            Còn {rest} model khác.{" "}
            <a href="#pricing" className="font-medium text-text-main underline underline-offset-4">
              Xem trong bảng giá
            </a>
          </p>
        ) : null}

        <p className="mt-4 text-sm text-text-subtle">
          Credit của gói bị trừ theo giá token của từng model, nên model đắt dùng credit nhanh hơn.
        </p>
      </div>
    </section>
  );
}

ModelsSection.propTypes = {
  models: PropTypes.array.isRequired,
  copy: PropTypes.object.isRequired,
};
