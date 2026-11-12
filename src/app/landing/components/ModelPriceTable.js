"use client";

import { useState } from "react";
import { fmtRate } from "./salesData";
import { percentLabel, dateTimeLabel, reasonsLabel } from "@/shared/utils/discountFormat";

/**
 * Model price list shared by the public /models page and /account/models
 * (change models-notifications). Prices are $ per 1M tokens; a discounted model
 * shows the lowered price, the list price struck through, "Giảm X%", the end and
 * the reasons. A table from `md`, cards below.
 *
 * `rows`: [{ name, kind?, input, output, cached, discount?: { percentBp, endsAt,
 * reasons }, discounted?: { input, output, cached } }]
 */
export default function ModelPriceTable({ rows = [], showKind = false, emptyText = "Chưa có model nào." }) {
  if (rows.length === 0) {
    return <p className="border border-dashed border-border px-6 py-10 text-center text-sm text-text-muted">{emptyText}</p>;
  }
  return (
    <>
      <div className="hidden overflow-x-auto border border-border bg-surface md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {["Model", ...(showKind ? ["Loại"] : []), "Input", "Output", "Cache"].map((label, i) => (
                <th
                  key={label}
                  scope="col"
                  className={`meta px-4 py-2.5 font-medium text-text-muted whitespace-nowrap ${i > (showKind ? 1 : 0) ? "text-right" : ""}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-border align-top last:border-b-0">
                <td className="px-4 py-3">
                  <ModelName name={row.name} />
                  <DiscountNote discount={row.discount} />
                </td>
                {showKind ? <td className="px-4 py-3 text-sm text-text-muted">{kindLabel(row.kind)}</td> : null}
                {["input", "output", "cached"].map((field) => (
                  <td key={field} className="px-4 py-3 text-right font-mono text-[13px] tabular-nums whitespace-nowrap">
                    <Rate list={row[field]} shown={row.discounted ? row.discounted[field] : row[field]} discounted={Boolean(row.discount)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li key={row.name} className="flex flex-col gap-3 border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <ModelName name={row.name} />
              {showKind ? <span className="text-xs text-text-muted">{kindLabel(row.kind)}</span> : null}
            </div>
            <DiscountNote discount={row.discount} />
            <dl className="grid grid-cols-3 gap-2">
              {[["input", "Input"], ["output", "Output"], ["cached", "Cache"]].map(([field, label]) => (
                <div key={field} className="flex flex-col gap-1">
                  <dt className="meta text-text-muted">{label}</dt>
                  <dd className="font-mono text-[13px] tabular-nums">
                    <Rate list={row[field]} shown={row.discounted ? row.discounted[field] : row[field]} discounted={Boolean(row.discount)} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-muted">Giá tính theo $ cho 1 triệu token.</p>
    </>
  );
}

function kindLabel(kind) {
  if (kind === "image") return "Tạo ảnh";
  return "Chat";
}

function Rate({ list, shown, discounted }) {
  if (!discounted || !(Number(list) > 0)) return <span className="text-text-main">${fmtRate(shown)}</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="text-text-main">${fmtRate(shown)}</span>
      <span className="text-[11px] text-text-muted line-through">${fmtRate(list)}</span>
    </span>
  );
}

function DiscountNote({ discount }) {
  if (!discount) return null;
  const reason = reasonsLabel(discount.reasons);
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <span className="inline-block w-fit border border-brand-500/30 bg-brand-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-main">
        Giảm {percentLabel(discount.percentBp)}
        {discount.endsAt ? ` · đến ${dateTimeLabel(discount.endsAt)}` : ""}
      </span>
      {reason ? <span className="text-xs text-text-muted">Lý do: {reason}</span> : null}
    </div>
  );
}

function ModelName({ name }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-sm text-text-main" title={name}>{name}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Sao chép tên model ${name}`}
        className="inline-flex size-7 shrink-0 items-center justify-center border border-border text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main"
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{copied ? "check" : "content_copy"}</span>
      </button>
      <span role="status" className="sr-only">{copied ? `Đã sao chép ${name}` : ""}</span>
    </span>
  );
}
