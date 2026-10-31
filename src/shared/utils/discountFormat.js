// Display helpers for time-limited model discounts (spec model-discounts).
// Pure and locale-stable (fixed Vietnamese wording and a fixed time zone) so a
// server-rendered page and its hydrated client agree.

const TZ = "Asia/Ho_Chi_Minh";

/** Basis points as a Vietnamese percent label: 2000 -> "20%", 1250 -> "12,5%". */
export function percentLabel(bp) {
  const n = Math.max(0, Math.round(Number(bp) || 0));
  const whole = Math.floor(n / 100);
  const frac = String(n % 100).padStart(2, "0").replace(/0+$/, "");
  return `${frac ? `${whole},${frac}` : whole}%`;
}

/** "còn 2 ngày 3 giờ" / "còn 5 giờ 10 phút" / "còn 12 phút" / "sắp hết"; "" when there is no end. */
export function remainingLabel(endsAtIso, nowMs = Date.now()) {
  if (!endsAtIso) return "";
  const end = new Date(endsAtIso).getTime();
  if (!Number.isFinite(end)) return "";
  const left = end - nowMs;
  if (left <= 0) return "đã hết hạn";
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `còn ${days} ngày${hours > 0 ? ` ${hours} giờ` : ""}`;
  if (hours > 0) return `còn ${hours} giờ${mins > 0 ? ` ${mins} phút` : ""}`;
  if (mins > 0) return `còn ${mins} phút`;
  return "sắp hết";
}

/** "05/11/2026 17:00" in Vietnam time; "" for an invalid or missing instant. */
export function dateTimeLabel(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(t);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}
