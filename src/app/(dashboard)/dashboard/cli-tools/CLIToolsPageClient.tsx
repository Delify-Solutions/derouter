"use client";

import { useState, useEffect } from "react";
import { CardSkeleton } from "@/shared/components";
import { apiGet } from "@/shared/api/client";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools";
import { MitmLinkCard } from "./components";
import ToolSummaryCard from "./components/ToolSummaryCard";
import type { CliTool, CliToolsAllStatusesResponse } from "./components/cliTools.types";

interface CLIToolsPageClientProps {
  machineId: string;
}

export default function CLIToolsPageClient({ machineId }: CLIToolsPageClientProps) {
  const [loading, setLoading] = useState(true);
  const [toolStatuses, setToolStatuses] = useState<CliToolsAllStatusesResponse>({});

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await apiGet<CliToolsAllStatusesResponse>("/api/cli-tools/all-statuses");
        if (mounted) setToolStatuses(data);
      } catch (error) {
        console.log("Error fetching tool statuses:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const regularTools = Object.entries(CLI_TOOLS) as [string, CliTool][];
  const mitmTools = Object.entries(MITM_TOOLS) as [string, CliTool][];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-1 sm:px-0">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {regularTools.map(([toolId, tool]) => (
          <ToolSummaryCard key={toolId} toolId={toolId} tool={tool} status={toolStatuses[toolId]} />
        ))}
      </div>
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="flex items-center gap-2 px-1">
          <span className="material-symbols-outlined text-[18px] text-primary">security</span>
          <h2 className="text-sm font-semibold text-text-main">MITM Tools</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {mitmTools.map(([toolId, tool]) => (
            <MitmLinkCard key={toolId} tool={tool} />
          ))}
        </div>
      </div>
    </div>
  );
}
