"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import VendorCostFields from "./VendorCostFields";
import { emptyVendorCostDraft, vendorCostRecordToDraft, vendorCostDraftToRecord } from "@/shared/utils/vendorCostMatch";

// Edit affordance for an already-added custom model's vendor cost (spec
// vendor-cost-pricing), opened from ModelRow's "Thêm giá vốn" / "Sửa giá vốn" button.
// Loads the current record (if any) on open, then saves/clears through `onSave`.
export default function VendorCostModal({ isOpen, provider, model, onSave, onClose }) {
  const [draft, setDraft] = useState(emptyVendorCostDraft);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setLoading(true);
    fetch(`/api/vendor-cost?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`)
      .then((res) => res.json())
      .then((data) => setDraft(vendorCostRecordToDraft(data?.record)))
      .catch(() => setDraft(emptyVendorCostDraft()))
      .finally(() => setLoading(false));
  }, [isOpen, provider, model]);

  const handleSave = async () => {
    let record;
    try {
      record = vendorCostDraftToRecord(draft);
    } catch (e) {
      setError(e.message);
      return;
    }
    setSaving(true);
    try {
      const ok = await onSave(record);
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const ok = await onSave(null);
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Giá vốn — ${model}`} size="lg">
      {loading ? (
        <p className="text-sm text-vx-text-muted">Đang tải...</p>
      ) : (
        <div className="flex flex-col gap-4">
          <VendorCostFields draft={draft} onChange={setDraft} />
          {error && (
            <div className="flex items-start gap-2 text-sm text-vx-danger">
              <span className="material-symbols-outlined text-base shrink-0">cancel</span>
              <span>{error}</span>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Button onClick={handleClear} variant="ghost" disabled={saving} className="text-vx-danger">
              Xóa giá vốn
            </Button>
            <div className="flex-1" />
            <Button onClick={onClose} variant="ghost" disabled={saving}>Hủy</Button>
            <Button onClick={handleSave} disabled={saving} loading={saving}>Lưu</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

VendorCostModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string.isRequired,
  model: PropTypes.string.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
