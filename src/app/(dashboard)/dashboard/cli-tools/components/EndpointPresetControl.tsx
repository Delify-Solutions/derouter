"use client";

import { useEffect, useMemo, useState } from "react";
import type { EndpointPreset } from "./cliTools.types";

const STORAGE_KEY = "derouter.cliToolEndpointPresets";

function maskApiKey(apiKey: string): string {
  if (!apiKey) return "No API key";
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}...`;
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

function normalizePresets(value: unknown): EndpointPreset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((preset): preset is EndpointPreset =>
    typeof preset === "object" && preset !== null &&
    "name" in preset && "baseUrl" in preset && "apiKey" in preset &&
    typeof preset.name === "string" && typeof preset.baseUrl === "string" && typeof preset.apiKey === "string"
  );
}

function readPresets(): EndpointPreset[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizePresets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function writePresets(presets: EndpointPreset[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

interface EndpointPresetControlProps {
  baseUrl: string;
  apiKey: string;
  onBaseUrlChange: (url: string) => void;
  onApiKeyChange: (key: string) => void;
}

export default function EndpointPresetControl({
  baseUrl,
  apiKey,
  onBaseUrlChange,
  onApiKeyChange,
}: EndpointPresetControlProps) {
  const [presets, setPresets] = useState<EndpointPreset[]>([]);
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    setPresets(readPresets());
  }, []);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.name === selectedName) || null,
    [presets, selectedName]
  );

  const handleSelect = (name: string) => {
    setSelectedName(name);
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    onBaseUrlChange(preset.baseUrl);
    onApiKeyChange(preset.apiKey || "");
  };

  const handleSave = () => {
    const trimmedBaseUrl = (baseUrl || "").trim();
    const trimmedApiKey = (apiKey || "").trim();
    if (!trimmedBaseUrl || !trimmedApiKey) return;

    let defaultName = selectedPreset?.name || trimmedBaseUrl;
    try {
      defaultName = selectedPreset?.name || new URL(trimmedBaseUrl).host;
    } catch {
      defaultName = selectedPreset?.name || trimmedBaseUrl;
    }
    const name = window.prompt("Preset name", defaultName);
    if (!name?.trim()) return;

    const nextPresets = [
      ...presets.filter((preset) => preset.name !== name.trim()),
      { name: name.trim(), baseUrl: trimmedBaseUrl, apiKey: trimmedApiKey },
    ].sort((a, b) => a.name.localeCompare(b.name));

    setPresets(nextPresets);
    setSelectedName(name.trim());
    writePresets(nextPresets);
  };

  const handleDelete = () => {
    if (!selectedPreset) return;
    const nextPresets = presets.filter((preset) => preset.name !== selectedPreset.name);
    setPresets(nextPresets);
    setSelectedName("");
    writePresets(nextPresets);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right">Preset</span>
      <span className="material-symbols-outlined text-text-muted text-[14px]">arrow_forward</span>
      <select
        value={selectedName}
        onChange={(event) => handleSelect(event.target.value)}
        className="flex-1 px-2 py-1.5 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
      >
        <option value="">Manual / current endpoint</option>
        {presets.map((preset) => (
          <option key={preset.name} value={preset.name}>
            {preset.name} - {preset.baseUrl} ({maskApiKey(preset.apiKey || "")})
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleSave}
        disabled={!baseUrl || !apiKey}
        className="px-2 py-1.5 rounded border text-xs bg-surface border-border text-text-main hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        title="Save current Base URL and API key as a browser-local preset"
      >
        Save
      </button>
      {selectedPreset && (
        <button
          type="button"
          onClick={handleDelete}
          className="p-1 text-text-muted hover:text-red-500 rounded transition-colors"
          title="Delete selected preset"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
        </button>
      )}
    </div>
  );
}
