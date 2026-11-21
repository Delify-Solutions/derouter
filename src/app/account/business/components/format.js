// Display helpers shared by the business customer pages. No imports: they are used
// from client components and must stay free of server-only modules.

/** "4.9 MB" / "20 MB" / "1.5 GB" — the unit the quota line speaks in. */
export function fmtDocSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Vietnamese label of a guard category, for "Đã chặn: chính trị". */
export const CATEGORY_LABELS = {
  sovereignty: "chủ quyền",
  political: "chính trị",
  injection: "thay đổi chỉ dẫn",
  offtopic: "ngoài phạm vi",
  strict_no_context: "không có tài liệu phù hợp",
  guard_unavailable: "kiểm duyệt gián đoạn",
  output_sovereignty: "câu trả lời sai chủ quyền",
  output_political: "câu trả lời chính trị",
  output_offtopic: "câu trả lời ngoài phạm vi",
};

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category ?? "";
}

/** Document status → tag tone, icon and Vietnamese text (never colour alone). */
export const STATUS_VIEW = {
  processing: { tone: "warning", icon: "progress_activity", label: "Đang xử lý" },
  ready: { tone: "success", icon: "check_circle", label: "Sẵn sàng" },
  failed: { tone: "danger", icon: "error", label: "Lỗi" },
  stale: { tone: "warning", icon: "sync_problem", label: "Cần xử lý lại" },
};

export function statusView(status) {
  return STATUS_VIEW[status] ?? STATUS_VIEW.failed;
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return `${time} ${date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
}
