import { notFound } from "next/navigation";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getMachineId } from "@/shared/utils/machine";
import ToolDetailClient from "./ToolDetailClient";

interface ToolDetailPageProps {
  params: Promise<{ toolId: string }>;
}

export default async function ToolDetailPage({ params }: ToolDetailPageProps) {
  const { toolId } = await params;
  if (!CLI_TOOLS[toolId as keyof typeof CLI_TOOLS]) notFound();
  const machineId = await getMachineId();
  return <ToolDetailClient toolId={toolId} machineId={machineId} />;
}
