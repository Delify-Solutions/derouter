"use client";

import React from "react";
import { CAPACITY_META } from "@/shared/constants/models";
import Tooltip from "./Tooltip";

export interface CapacityBadgesProps {
  caps?: Record<string, boolean> | null;
  className?: string;
  colorOverride?: string;
  size?: number;
}

// Render small icon badges for a model's capabilities (only those set true).
// colorOverride: force a single color class for all badges (default: per-cap color).
// size: icon font-size in px (default 16).
export default function CapacityBadges({ caps, className = "", colorOverride, size = 16 }: CapacityBadgesProps) {
  if (!caps) return null;
  const active = Object.keys(CAPACITY_META).filter((k) => caps[k]);
  if (active.length === 0) return null;

  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {active.map((k) => {
        const meta = CAPACITY_META[k] as { label: string; desc: string; icon: string; color: string };
        return (
          <Tooltip key={k} text={`${meta.label} — ${meta.desc}`}>
            <span
              className={`material-symbols-outlined leading-none cursor-help ${colorOverride || meta.color}`}
              style={{ fontSize: `${size}px` }}
            >
              {meta.icon}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}
