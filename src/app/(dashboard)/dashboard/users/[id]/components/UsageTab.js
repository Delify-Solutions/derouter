"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Button, SegmentedControl } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";

/**
 * `Usage` — cost per day as a bar chart plus a per-model table, across every key of
 * the user (spec admin-user-management, `Usage` tab).
 *
 * recharts is already a dependency; the chart is deliberately plain (one series, no
 * animation) to match ui-dna: content does not animate in.
 */
export default function UsageTab({ userId }) {
  const [range, setRange] = useState("7d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState({ daily: [], byModel: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${userId}/usage?range=${range}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được usage");
      setData({
        daily: Array.isArray(body.daily) ? body.daily : [],
        byModel: Array.isArray(body.byModel) ? body.byModel : [],
      });
    } catch (e) {
      setError(e.message || "Không tải được usage");
    } finally {
      setLoading(false);
    }
  }, [userId, range]);

  useEffect(() => { load(); }, [load]);

  const chartData = data.daily.map((row) => ({
    date: row.date.slice(5),
    cost: row.costNanoUsd / 1e9,
    requests: row.requests,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          options={[
            { value: "7d", label: "7 ngày" },
            { value: "30d", label: "30 ngày" },
          ]}
          value={range}
          onChange={setRange}
        />
        <Button variant="secondary" size="sm" icon="refresh" onClick={load} disabled={loading}>
          Tải lại
        </Button>
      </div>

      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="h-64 border border-border bg-surface" aria-hidden="true" />
      ) : (
        <>
          <section className="border border-border bg-surface p-5">
            <h2 className="meta text-text-muted">Chi phí mỗi ngày</h2>
            {chartData.length === 0 ? (
              <p className="mt-4 text-sm text-text-muted">Không có lưu lượng trong khoảng này.</p>
            ) : (
              <div className="mt-4 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="0" stroke="var(--color-border, #e4e4e7)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="currentColor" tickLine={false} />
                    <YAxis tick={{ fontSize: 11 }} stroke="currentColor" tickLine={false} axisLine={false} />
                    <Tooltip
                      formatter={(value) => [`$${Number(value).toFixed(4)}`, "Chi phí"]}
                      contentStyle={{ border: "1px solid var(--color-border, #e4e4e7)", borderRadius: 0 }}
                    />
                    <Bar dataKey="cost" fill="#16a34a" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="meta text-text-muted">Theo model</h2>
            {data.byModel.length === 0 ? (
              <div className="border border-border bg-surface px-6 py-8">
                <p className="text-sm text-text-muted">Chưa có request nào trong khoảng này.</p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-border bg-surface">
                <table className="w-full min-w-[600px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-2">
                      <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Model</th>
                      <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Request</th>
                      <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Token vào</th>
                      <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Token ra</th>
                      <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Chi phí</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((row) => (
                      <tr key={row.model} className="border-b border-border last:border-b-0">
                        <td className="max-w-[260px] truncate px-4 py-2 font-mono text-[12px] text-text-main" title={row.model}>
                          {row.model}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[12px] text-text-muted">{row.requests}</td>
                        <td className="px-4 py-2 text-right font-mono text-[12px] text-text-muted">{row.promptTokens}</td>
                        <td className="px-4 py-2 text-right font-mono text-[12px] text-text-muted">{row.completionTokens}</td>
                        <td className="px-4 py-2 text-right font-mono text-[12px] text-text-main">{fmtUsdNano(row.costNanoUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
