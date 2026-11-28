"use client";

import Link from "next/link";
import { Card, Badge } from "@/shared/components";
import Image from "next/image";

/**
 * Clickable card for MITM tools — navigates to /dashboard/mitm on click.
 */
export default function MitmLinkCard({ tool }) {
  return (
    <Link href="/dashboard/mitm" className="block">
      <Card padding="sm" className="overflow-hidden hover:border-vx-primary/50 transition-colors cursor-pointer">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
              <Image
                src={tool.image}
                alt={tool.name}
                width={32}
                height={32}
                className="size-8 object-contain rounded-vx-md"
                sizes="32px"
                onError={(e) => { e.target.style.display = "none"; }}
              loading="lazy"
              decoding="async"
              />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate font-medium text-sm" title={tool.name}>{tool.name}</h3>
                <Badge variant="info" size="xs" className="shrink-0">MITM</Badge>
              </div>
              <p className="text-xs text-vx-text-muted truncate" title={tool.description}>{tool.description}</p>
            </div>
          </div>
          <span className="material-symbols-outlined shrink-0 text-vx-text-muted text-[20px]">chevron_right</span>
        </div>
      </Card>
    </Link>
  );
}
