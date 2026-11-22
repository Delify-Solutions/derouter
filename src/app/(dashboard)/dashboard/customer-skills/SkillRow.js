"use client";

import { Button, Badge } from "@/shared/components";
import { runtimeLabel } from "@/lib/skills/runtimes.js";

function fmtDate(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * One skill, as a row: the shape the flat admin list and a bundle's expanded skill
 * list both use, so "hide", "edit" and "delete" look and behave the same everywhere
 * a skill shows up.
 */
export default function SkillRow({ row, busy, onTogglePublished, onEdit, onDelete, checked, onToggleChecked }) {
  return (
    <div className="flex flex-wrap items-start gap-3 border border-border bg-surface p-4">
      {onToggleChecked && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleChecked(row.id)}
          aria-label={`Chọn ${row.name}`}
          className="mt-1 size-4 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-semibold text-text-main">{row.name}</h3>
          {row.isPublished ? <Badge variant="success" size="sm" dot>Đang phát hành</Badge> : <Badge variant="default" size="sm" dot>Bản nháp</Badge>}
          {row.audience === "internal" && <Badge variant="warning" size="sm">Nội bộ</Badge>}
          {row.category && <Badge variant="info" size="sm">{row.category}</Badge>}
          {row.version && <Badge variant="default" size="sm">v{row.version}</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {row.allAgents ? (
            <span className="border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">Mọi agent</span>
          ) : (
            (row.targets || []).map((id) => (
              <span key={id} className="border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{runtimeLabel(id)}</span>
            ))
          )}
        </div>
        <p className="mt-1 font-mono text-[11px] text-text-subtle">
          {row.slug} · {row.downloadCount ?? 0} lượt tải · cập nhật {fmtDate(row.updatedAt)}
        </p>
        {row.summary && <p className="mt-1 text-xs leading-5 text-text-muted">{row.summary}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onTogglePublished(row)} disabled={busy}>
          {row.isPublished ? "Ẩn" : "Phát hành"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onEdit(row)} disabled={busy}>Sửa</Button>
        <Button variant="ghost" size="sm" onClick={() => onDelete(row)} disabled={busy} className="text-red-600 hover:bg-red-500/10">Xoá</Button>
      </div>
    </div>
  );
}
