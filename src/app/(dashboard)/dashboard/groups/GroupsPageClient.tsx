// @ts-nocheck
"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Select, Modal, CardSkeleton, ConfirmModal, AllowedModelsPicker } from "@/shared/components";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/shared/api/client";
import type { KeyGroup, GroupListResponse } from "@/shared/types";

type ConfirmState = { title: string; message: string; onConfirm: () => Promise<void> } | null;

export default function GroupsPageClient() {
  const [groups, setGroups] = useState<KeyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<KeyGroup | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  // Form state
  const [name, setName] = useState("");
  const [rpm, setRpm] = useState("");
  const [tpm, setTpm] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [resetWindow, setResetWindow] = useState("");
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchGroups = useCallback(async () => {
    try {
      const data = await apiGet<GroupListResponse>("/api/groups");
      setGroups(data.groups || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const resetForm = () => {
    setName("");
    setRpm("");
    setTpm("");
    setBudgetUsd("");
    setResetWindow("");
    setAllowedModels([]);
    setIsActive(true);
    setFormError("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setShowModal(true);
  };

  const openEdit = (group: KeyGroup) => {
    setName(group.name || "");
    setRpm(group.rpm != null ? String(group.rpm) : "");
    setTpm(group.tpm != null ? String(group.tpm) : "");
    setBudgetUsd(group.budgetUsd != null ? String(group.budgetUsd) : "");
    setResetWindow(group.resetWindow || "");
    setAllowedModels(Array.isArray(group.allowedModels) ? group.allowedModels : []);
    setIsActive(group.isActive !== false);
    setFormError("");
    setEditing(group);
    setShowModal(true);
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setFormError("Name is required"); return; }
    setSaving(true);
    setFormError("");

    const body = {
      name: name.trim(),
      isActive,
      rpm: rpm ? Number(rpm) : null,
      tpm: tpm ? Number(tpm) : null,
      budgetUsd: budgetUsd ? Number(budgetUsd) : null,
      resetWindow: resetWindow || null,
      allowedModels: allowedModels && allowedModels.length ? allowedModels : null,
    };

    try {
      if (editing) {
        await apiPatch(`/api/groups/${editing.id}`, body);
      } else {
        await apiPost("/api/groups", body);
      }
      await fetchGroups();
      setShowModal(false);
      resetForm();
    } catch (e) {
      if (e instanceof ApiError) {
        setFormError(e.message || "Failed to save group");
      } else {
        setFormError(e instanceof Error ? e.message : "Failed to save group");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (group: KeyGroup) => {
    setConfirmState({
      title: "Delete Group",
      message: `Delete group "${group.name}"?\n\nKeys in this group become custom keys (limits stay on each key).`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await apiDelete(`/api/groups/${group.id}`);
          await fetchGroups();
        } catch { /* ignore */ }
      }
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">group_work</span>
            Key Groups
          </h2>
          <Button icon="add" onClick={openCreate}>New Group</Button>
        </div>

        <p className="text-sm text-text-muted mb-4">
          A group pre-configures RPM, TPM, $ budget (+ reset window), and allowed models.
          Keys assigned to a group inherit its config and may narrow it.
        </p>

        {groups.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">group_work</span>
            </div>
            <p className="text-text-main font-medium mb-1">No groups yet</p>
            <p className="text-sm text-text-muted mb-4">Create a group to pre-configure key limits</p>
            <Button icon="add" onClick={openCreate}>New Group</Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <div
                key={group.id}
                className={`group flex items-start justify-between py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${group.isActive === false ? "opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{group.name}</p>
                    {group.isActive === false && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">paused</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {group.rpm != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{group.rpm} RPM</span>
                    )}
                    {group.tpm != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{group.tpm} TPM</span>
                    )}
                    {group.budgetUsd != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                        ${group.budgetUsd}{group.resetWindow ? `/${group.resetWindow}` : ""}
                      </span>
                    )}
                    {group.allowedModels && group.allowedModels.length > 0 && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted" title={group.allowedModels.join(", ")}>
                        {group.allowedModels.length} model{group.allowedModels.length > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(group.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(group)}
                    className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(group)}
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-all"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create / Edit Modal */}
      <Modal
        isOpen={showModal}
        title={editing ? "Edit Group" : "New Group"}
        onClose={() => { setShowModal(false); resetForm(); }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Group Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Standard Group"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="RPM"
              type="number"
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
              placeholder="Unlimited"
            />
            <Input
              label="TPM"
              type="number"
              value={tpm}
              onChange={(e) => setTpm(e.target.value)}
              placeholder="Unlimited"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Budget ($)"
              type="number"
              step="0.01"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
              placeholder="Unlimited"
            />
            <Select
              label="Reset window"
              value={resetWindow}
              onChange={(e) => setResetWindow(e.target.value)}
              placeholder="No reset"
              options={[
                { value: "", label: "No reset / unlimited" },
                { value: "5h", label: "Every 5 hours" },
                { value: "day", label: "Every day" },
                { value: "week", label: "Every week" },
              ]}
            />
          </div>

          <AllowedModelsPicker
            value={allowedModels}
            onChange={setAllowedModels}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4"
            />
            Active
          </label>

          {formError && (
            <p className="text-sm text-red-500 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {formError}
            </p>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSubmit} fullWidth disabled={saving || !name.trim()}>
              {saving ? "Saving..." : (editing ? "Save" : "Create")}
            </Button>
            <Button onClick={() => { setShowModal(false); resetForm(); }} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
