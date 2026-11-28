"use client";

import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import CacheRefundsTable from "./CacheRefundsTable";

export default function CacheRefundsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <CacheRefundsTable />
    </Suspense>
  );
}
