import PropTypes from "prop-types";
import "./PipelineDiagram.css";

/**
 * The five steps of a business answer, as the hero shows them (spec
 * business-landing "Animated pipeline"): the question comes in, the guard filters
 * it, the company documents are consulted, the model answers, and the output check
 * clears it.
 *
 * Every label is drawn twice: once in the SVG (which is `aria-hidden` — it is
 * decoration) and once in a visually hidden list, which is what a screen reader
 * reads.
 */
export const PIPELINE_STEPS = [
  { id: "question", label: "Câu hỏi", icon: "help" },
  { id: "guard", label: "Lọc an toàn", icon: "shield" },
  { id: "docs", label: "Tài liệu công ty", icon: "folder" },
  { id: "answer", label: "Trả lời", icon: "chat" },
  { id: "check", label: "Kiểm duyệt", icon: "verified" },
];

// Geometry: five 132×56 chips, 40px apart, one connector through their centres.
const CHIP_W = 132;
const CHIP_H = 56;
const GAP = 40;
const MARGIN = 16;
const WIDTH = MARGIN * 2 + PIPELINE_STEPS.length * CHIP_W + (PIPELINE_STEPS.length - 1) * GAP;
const HEIGHT = 132;
const CHIP_Y = 44;
const LINE_Y = CHIP_Y + CHIP_H / 2;
const LINE_LENGTH = WIDTH - MARGIN * 2 - CHIP_W;

const chipX = (index) => MARGIN + index * (CHIP_W + GAP);

const ICONS = {
  help: <path d="M0 -1.5a1.5 1.5 0 1 1 1.5 1.5c-.8 0-1.5.7-1.5 1.5v1" />,
  shield: <path d="M0 -6l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6v-4z" />,
  folder: <path d="M-6 -4h4l1.5 2H6v6h-12z" />,
  chat: <path d="M-6 -4h12v8h-6l-3 3v-3h-3z" />,
  verified: <path d="M-6 0l3 3 6-6" />,
};

export default function PipelineDiagram({ className = "" }) {
  return (
    <figure className={`m-0 ${className}`}>
      <svg
        className="biz-pipeline"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="presentation"
        aria-hidden="true"
        focusable="false"
      >
        {/* The connector, then the comet dash on top of it. */}
        <path
          className="biz-pipeline__track"
          d={`M${MARGIN + CHIP_W / 2} ${LINE_Y}H${MARGIN + CHIP_W / 2 + LINE_LENGTH}`}
        />
        <path
          className="biz-pipeline__comet"
          d={`M${MARGIN + CHIP_W / 2} ${LINE_Y}H${MARGIN + CHIP_W / 2 + LINE_LENGTH}`}
        />

        {PIPELINE_STEPS.map((step, index) => {
          const x = chipX(index);
          const number = index + 1;
          return (
            <g key={step.id}>
              <rect
                className={`biz-pipeline__chip biz-pipeline__chip--${number}`}
                x={x}
                y={CHIP_Y}
                width={CHIP_W}
                height={CHIP_H}
              />
              <text className="biz-pipeline__step" x={x + 12} y={CHIP_Y + 18}>
                {`0${number}`}
              </text>
              <g transform={`translate(${x + 24} ${CHIP_Y + 38})`}>
                <g className={`biz-pipeline__icon biz-pipeline__icon--${number}`}>{ICONS[step.icon]}</g>
              </g>
              <text className="biz-pipeline__label" x={x + 40} y={CHIP_Y + 42}>
                {step.label}
              </text>
            </g>
          );
        })}

        {/* The ping dot rides the last chip's top-right corner. */}
        <circle
          className="biz-pipeline__ping"
          cx={chipX(PIPELINE_STEPS.length - 1) + CHIP_W - 10}
          cy={CHIP_Y + 10}
          r={5}
        />
      </svg>

      {/* The diagram is decorative, so the steps are announced as text. */}
      <figcaption className="sr-only">
        <p>Quy trình trả lời của chatbot gồm {PIPELINE_STEPS.length} bước:</p>
        <ol>
          {PIPELINE_STEPS.map((step) => (
            <li key={step.id}>{step.label}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

PipelineDiagram.propTypes = {
  className: PropTypes.string,
};
