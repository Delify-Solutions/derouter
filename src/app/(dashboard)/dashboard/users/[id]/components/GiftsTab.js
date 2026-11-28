"use client";

import { useEffect, useState } from "react";
import { Card, Table } from "@/shared/components";
import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "@/shared/utils/money";
import { dateOf } from "@/shared/components/billing";

const KIND_LABEL = { plan: "Gói", credit: "Credit" };

/** `Mã quà tặng` — the customer's gift-code redemptions. */
export default function GiftsTab({ userId }) {
  const [redemptions, setRedemptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}/gifts`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Không tải được mã quà tặng");
        if (!cancelled) setRedemptions(Array.isArray(body.redemptions) ? body.redemptions : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Không tải được mã quà tặng");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {redemptions.length === 0 ? (
        <Card padding="lg">
          <p className="font-medium text-text-main">Chưa nhập mã quà tặng nào</p>
        </Card>
      ) : (
        <Table className="min-w-[600px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell>Mã</Table.HeaderCell>
              <Table.HeaderCell>Loại</Table.HeaderCell>
              <Table.HeaderCell>Giá trị</Table.HeaderCell>
              <Table.HeaderCell>Số ngày</Table.HeaderCell>
              <Table.HeaderCell>Nhập lúc</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {redemptions.map((row) => (
              <Table.Row key={row.id}>
                <Table.Cell className="font-mono text-[12px] text-text-main">{row.code || "—"}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{KIND_LABEL[row.grantKind] || row.grantKind || "—"}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main">
                  {row.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : row.creditNanoUsd == null ? "—" : fmtUsdNano(row.creditNanoUsd)}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{row.durationDays ?? "—"}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{dateOf(row.redeemedAt)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}
