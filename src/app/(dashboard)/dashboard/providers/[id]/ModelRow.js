import PropTypes from "prop-types";
import { Badge, CapacityBadges } from "@/shared/components";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, onEditVendorCost, hasVendorCost, caps, thinkingSuffix }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const borderColor = testStatus === "ok"
    ? "border-vx-success/40"
    : testStatus === "error"
    ? "border-vx-danger/40"
    : "border-vx-border";

  const iconColor = testStatus === "ok"
    ? "var(--vx-success)"
    : testStatus === "error"
    ? "var(--vx-danger)"
    : undefined;

  return (
    <div className={`group min-w-0 max-w-full rounded-vx-md border px-3 py-2 ${borderColor} hover:bg-vx-surface-2/60`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span
          className="material-symbols-outlined shrink-0 text-base"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="max-w-[72vw] truncate rounded-vx-sm bg-vx-surface-2 px-1.5 py-0.5 font-mono text-xs text-vx-text-muted sm:max-w-[360px]">{displayModel}</code>
          <span className="flex min-w-0 items-center text-[9px] gap-1 pl-1">
            {model.name && <span className="truncate text-[9px] italic text-vx-text-muted/70">{model.name}</span>}
            {/* Account catalog price (DeepAI): free, Theos per request, premium */}
            {typeof model.theosPerRequest === "string" && (
              <Badge size="sm" className="shrink-0 font-mono">
                {/[1-9]/.test(model.theosPerRequest) ? `${model.theosPerRequest} Theos/request` : "Free"}
              </Badge>
            )}
            {model.premier === true && (
              <Badge size="sm" className="shrink-0 font-mono">Premium</Badge>
            )}
            <CapacityBadges caps={caps} colorOverride="text-vx-text-muted/70" size={12} />
          </span>
        </div>
        {onEditVendorCost && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onEditVendorCost}
              className="rounded-vx-sm p-0.5 text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-primary"
            >
              {/* Distinct glyph (not just colour) marks whether this model already has a
                  vendor cost set — ui-dna.md "no colour-only status". */}
              <span className="material-symbols-outlined text-sm">{hasVendorCost ? "payments" : "add_card"}</span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-vx-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {hasVendorCost ? "Sửa giá vốn" : "Thêm giá vốn"}
            </span>
          </div>
        )}
        {onTest && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onTest}
              disabled={isTesting}
              className={`rounded-vx-sm p-0.5 text-vx-text-muted transition-opacity hover:bg-vx-surface-2 hover:text-vx-primary ${isTesting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
            >
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-vx-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        <div className="relative shrink-0 group/btn">
          <button
            onClick={() => onCopy(displayModel, `model-${model.id}`)}
            className="rounded-vx-sm p-0.5 text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-primary"
          >
            <span className="material-symbols-outlined text-sm">
              {copied === `model-${model.id}` ? "check" : "content_copy"}
            </span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-vx-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isCustom ? (
          <button
            onClick={onDeleteAlias}
            className="ml-auto rounded-vx-sm p-0.5 text-vx-text-muted opacity-100 transition-opacity hover:bg-vx-danger/10 hover:text-vx-danger sm:opacity-0 sm:group-hover:opacity-100"
            title="Remove custom model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : onDisable ? (
          <button
            onClick={onDisable}
            className="ml-auto rounded-vx-sm p-0.5 text-vx-text-muted opacity-100 transition-opacity hover:bg-vx-danger/10 hover:text-vx-danger sm:opacity-0 sm:group-hover:opacity-100"
            title="Disable this model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  onEditVendorCost: PropTypes.func,
  hasVendorCost: PropTypes.bool,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
