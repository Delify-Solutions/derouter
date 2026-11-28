"use client";

import PropTypes from "prop-types";
import { Input, Toggle } from "@/shared/components";
import { VENDOR_COST_RATE_FIELDS } from "@/shared/utils/vendorCostMatch";

// Admin-only vendor (upstream) cost form (spec vendor-cost-pricing): the same 5-field
// rate shape as the customer sell-price form, plus an optional on-peak/off-peak
// schedule. Shared by AddCustomModelModal (new model) and VendorCostModal (editing an
// existing model's vendor cost from ModelRow). Never touches customer-facing pricing.
export default function VendorCostFields({ draft, onChange }) {
  const setRate = (key, value) => onChange({ ...draft, rate: { ...draft.rate, [key]: value } });
  const setOffPeakRate = (key, value) => onChange({ ...draft, offPeakRate: { ...draft.offPeakRate, [key]: value } });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Giá vốn (vendor cost)</label>
        <Toggle
          checked={!!draft.peakEnabled}
          onChange={(v) => onChange({ ...draft, peakEnabled: v })}
          label="Có giá theo khung giờ"
          size="sm"
        />
      </div>
      <p className="text-xs text-vx-text-muted -mt-1">
        Giá vốn chỉ dùng để tính lãi/lỗ cho admin, không ảnh hưởng tới giá khách hàng trả.
        Để trống nếu chưa có dữ liệu giá vốn.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {VENDOR_COST_RATE_FIELDS.map((f) => (
          <Input
            key={f.key}
            label={draft.peakEnabled ? `${f.label} (bình thường)` : f.label}
            type="number"
            step="0.01"
            min="0"
            value={draft.rate[f.key]}
            onChange={(e) => setRate(f.key, e.target.value)}
            placeholder="0.00"
          />
        ))}
      </div>

      {draft.peakEnabled && (
        <div className="flex flex-col gap-3 rounded-vx-md border border-vx-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Bắt đầu off-peak (giờ VN)"
              type="time"
              value={draft.start}
              onChange={(e) => onChange({ ...draft, start: e.target.value })}
            />
            <Input
              label="Kết thúc off-peak (giờ VN)"
              type="time"
              value={draft.end}
              onChange={(e) => onChange({ ...draft, end: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {VENDOR_COST_RATE_FIELDS.map((f) => (
              <Input
                key={f.key}
                label={`${f.label} (off-peak)`}
                type="number"
                step="0.01"
                min="0"
                value={draft.offPeakRate[f.key]}
                onChange={(e) => setOffPeakRate(f.key, e.target.value)}
                placeholder="0.00"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

VendorCostFields.propTypes = {
  draft: PropTypes.shape({
    rate: PropTypes.object.isRequired,
    peakEnabled: PropTypes.bool,
    offPeakRate: PropTypes.object,
    start: PropTypes.string,
    end: PropTypes.string,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};
