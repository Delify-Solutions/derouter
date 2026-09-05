"use client";

import React from "react";
import Card from "./Card";

interface FieldSchema {
  label: string;
  format: (v: unknown) => React.ReactNode;
  isLink?: boolean;
  mono?: boolean;
}

interface ProviderNotice {
  apiKeyUrl?: string;
  text?: string;
}

interface ProviderInfo {
  name?: string;
  website?: string;
  notice?: ProviderNotice;
}

export interface ProviderConfig {
  mode?: string;
  defaultModel?: string;
  baseUrl?: string;
  costPerQuery?: number;
  pricingUrl?: string;
  freeTier?: string;
  freeMonthlyQuota?: number;
  searchTypes?: string[];
  formats?: string[];
  maxMaxResults?: number;
  maxCharacters?: number;
  [key: string]: unknown;
}

interface InfoRow {
  key: string;
  label: string;
  value: React.ReactNode;
  isLink?: boolean;
  mono?: boolean;
  raw: unknown;
}

// Only show fields user actually cares about
const FIELD_SCHEMA: Record<string, FieldSchema> = {
  mode:             { label: "Mode",       format: (v: unknown) => v as string },
  defaultModel:     { label: "Model",      format: (v: unknown) => v as string, mono: true },
  baseUrl:          { label: "Endpoint",   format: (v: unknown) => v as string, isLink: true, mono: true },
  costPerQuery:     { label: "Cost / call", format: (v: unknown) => (v as number) === 0 ? "Free" : `$${(v as number).toFixed(4)}` },
  pricingUrl:       { label: "Pricing",    format: () => "View pricing", isLink: true },
  freeTier:         { label: "Free tier",  format: (v: unknown) => v as string },
  freeMonthlyQuota: { label: "Free quota",  format: (v: unknown) => (v as number) === 0 ? "—" : (v as number) >= 999999 ? "Unlimited" : `${(v as number).toLocaleString()} / mo` },
  searchTypes:      { label: "Types",      format: (v: unknown) => (v as string[]).join(", ") },
  formats:          { label: "Formats",    format: (v: unknown) => (v as string[]).join(", ") },
  maxMaxResults:    { label: "Max results", format: (v: unknown) => v as string },
  maxCharacters:    { label: "Max chars",  format: (v: unknown) => (v as number).toLocaleString() },
};

export interface ProviderInfoCardProps {
  config?: ProviderConfig | null;
  provider?: ProviderInfo;
  title?: string;
}

export default function ProviderInfoCard({ config, provider, title = "Provider Info" }: ProviderInfoCardProps) {
  if (!config) return null;

  const rows: InfoRow[] = Object.entries(FIELD_SCHEMA)
    .filter(([key]: [string, FieldSchema]) => config[key] !== undefined && config[key] !== null && config[key] !== "")
    .map(([key, schema]: [string, FieldSchema]) => ({
      key,
      label: schema.label,
      value: schema.format(config[key]),
      isLink: schema.isLink,
      mono: schema.mono,
      raw: config[key],
    }));

  const signupUrl = provider?.notice?.apiKeyUrl || provider?.website;
  const noticeText = provider?.notice?.text;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {signupUrl && (
          <a
            href={signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">open_in_new</span>
            Get API Key
          </a>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {rows.map((r: InfoRow) => (
          <div key={r.key} className="flex items-center gap-3 min-w-0">
            <span className="text-xs text-text-muted w-28 shrink-0">{r.label}</span>
            {r.isLink ? (
              <a
                href={r.raw as string}
                target="_blank"
                rel="noopener noreferrer"
                className={`text-sm text-primary hover:underline truncate ${r.mono ? "font-mono" : ""}`}
              >
                {r.value}
              </a>
            ) : (
              <span className={`text-sm text-text-main truncate ${r.mono ? "font-mono" : ""}`}>
                {r.value}
              </span>
            )}
          </div>
        ))}
        {noticeText && (
          <div className="flex items-start gap-3 min-w-0 sm:col-span-2">
            <span className="text-xs text-text-muted w-28 shrink-0 mt-0.5">Notice</span>
            <span className="text-sm text-text-main leading-relaxed">{noticeText}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
