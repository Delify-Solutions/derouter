"use client";

import { useEffect, useMemo, useState } from "react";
import { Select, Button } from "@/shared/components";

const STORAGE_KEY = "derouter.cliToolEndpointPresets";

function maskApiKey(apiKey) {
  if (!apiKey) return "No API key";
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}...`;
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((preset) => preset?.name && preset?.baseUrl && preset?.apiKey);
}

function readPresets() {
  if (typeof window === "undefined") return [];
  try {
    return normalizePresets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function writePresets(presets) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
}

export default function EndpointPresetControl({
  baseUrl,
  apiKey,
  onBaseUrlChange,
  onApiKeyChange,
}) {
  const [presets, setPresets] = useState([]);
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    setPresets(readPresets());
  }, []);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.name === selectedName) || null,
    [presets, selectedName]
  );

  const handleSelect = (name) => {
    setSelectedName(name);
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    onBaseUrlChange(preset.baseUrl);
    onApiKeyChange(preset.apiKey);
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

    const nextPreset = { name: name.trim(), baseUrl: trimmedBaseUrl, apiKey: trimmedApiKey };
    const nextPresets = [
      ...presets.filter((preset) => preset.name !== nextPreset.name),
      nextPreset,
    ].sort((a, b) => a.name.localeCompare(b.name));

    setPresets(nextPresets);
    setSelectedName(nextPreset.name);
    writePresets(nextPresets);
  };

  const handleDelete = () => {
    if (!selectedPreset) return;
    const nextPresets = presets.filter((preset) => preset.name !== selectedPreset.name);
    setPresets(nextPresets);
    setSelectedName("");
    writePresets(nextPresets);
  };

  const presetOptions = [
    { value: "", label: "Manual / current endpoint" },
    ...presets.map((preset) => ({
      value: preset.name,
      label: `${preset.name} - ${preset.baseUrl} (${maskApiKey(preset.apiKey)})`,
    })),
  ];

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-sm font-semibold text-vx-text text-right">Preset</span>
      <span className="material-symbols-outlined text-vx-text-muted text-[14px]">arrow_forward</span>
      <Select
        value={selectedName}
        onChange={(event) => handleSelect(event.target.value)}
        options={presetOptions}
        className="flex-1"
      />
      <Button
        type="button"
        variant="light-outline"
        size="sm"
        onClick={handleSave}
        disabled={!baseUrl || !apiKey}
        title="Save current Base URL and API key as a browser-local preset"
        className="shrink-0"
      >
        Save
      </Button>
      {selectedPreset && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon="delete"
          onClick={handleDelete}
          aria-label="Delete selected preset"
          title="Delete selected preset"
          className="text-red-600 hover:bg-red-500/10"
        />
      )}
    </div>
  );
}
