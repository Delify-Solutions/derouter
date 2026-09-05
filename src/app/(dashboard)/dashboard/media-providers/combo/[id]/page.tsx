"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import { Card, Button, Input, Toggle, ModelSelectModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, ApiError } from "@/shared/api/client";
import type { Combo, ProviderConnection, ProviderListResponse, Settings, ComboListResponse, ModelAliasResponse } from "@/shared/types";

// Parse "providerId/model" or just "providerId" → { providerId, model }
function parseModelEntry(entry: string): { providerId: string; model: string } {
  if (typeof entry !== "string") return { providerId: "", model: "" };
  const idx = entry.indexOf("/");
  if (idx < 0) return { providerId: entry, model: "" };
  return { providerId: entry.slice(0, idx), model: entry.slice(idx + 1) };
}

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

const KIND_LABELS: Record<string, string> = {
  webSearch: "Web Search",
  webFetch: "Web Fetch",
  image: "Text to Image",
  tts: "Text To Speech",
};

const EXAMPLE_PATHS: Record<string, string> = {
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
};

type ExampleBodyFn = (n: string) => Record<string, unknown>;

const EXAMPLE_BODIES: Record<string, ExampleBodyFn> = {
  webSearch: (n) => ({ model: n, query: "What is the latest news about AI?", search_type: "web", max_results: 5 }),
  webFetch: (n) => ({ model: n, url: "https://example.com", format: "markdown" }),
  image: (n) => ({ model: n, prompt: "A cute cat playing piano", n: 1, size: "1024x1024" }),
  tts: (n) => ({ model: n, input: "Hello, this is a test.", voice: "alloy" }),
};

// Map combo.kind → listing route to go back to
function getListingHref(kind: string): string {
  if (kind === "webSearch" || kind === "webFetch") return "/dashboard/media-providers/web";
  return `/dashboard/media-providers/${kind}`;
}

interface TestResult {
  json?: string;
  imageUrl?: string;
  audioUrl?: string;
  latencyMs?: number;
}

export default function ComboDetailPage(): ReactElement | null {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [combo, setCombo] = useState<Combo | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [roundRobin, setRoundRobin] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});

  const fetchAll = async () => {
    try {
      const [comboRes, settingsRes, logsRes, keysRes, connsRes, aliasesRes] = await Promise.all([
        apiGet<Combo>(`/api/combos/${id}`).catch(() => null),
        apiGet<Settings>("/api/settings").catch(() => null),
        apiGet<{ logs?: string[] } | string[]>("/api/usage/logs").catch(() => null),
        apiGet<{ keys?: Array<{ isActive?: boolean; key: string }> }>("/api/keys").catch(() => null),
        apiGet<ProviderListResponse>("/api/providers").catch(() => null),
        apiGet<ModelAliasResponse>("/api/models/alias").catch(() => null),
      ]);
      if (aliasesRes) setModelAliases(aliasesRes.aliases || {});
      if (keysRes) {
        setApiKey((keysRes.keys || []).find((x) => x.isActive !== false)?.key || "");
      }
      if (connsRes) setConnections(connsRes.connections || []);
      if (!comboRes) { setCombo(null); setLoading(false); return; }
      setCombo(comboRes);
      setName(comboRes.name);
      setProviders(comboRes.models || []);
      if (settingsRes) {
        const strategies = settingsRes.comboStrategies as Record<string, { fallbackStrategy?: string }> || {};
        setRoundRobin(strategies[comboRes.name]?.fallbackStrategy === "round-robin");
      }
      if (logsRes) {
        const allLogs = Array.isArray(logsRes) ? logsRes : (logsRes.logs || []);
        setLogs(allLogs.filter((l) => typeof l === "string" && l.includes(comboRes.name)).slice(0, 50));
      }
    } catch { /* noop */ }
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchAll(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const validateName = (v: string): boolean => {
    if (!v.trim()) { setNameError("Name is required"); return false; }
    if (!VALID_NAME_REGEX.test(v)) { setNameError("Only letters, numbers, -, _ and ."); return false; }
    setNameError("");
    return true;
  };

  const saveCombo = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      await apiPut(`/api/combos/${id}`, patch);
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        alert(error.message || "Failed to save");
      } else {
        alert("Failed to save");
      }
      return false;
    }
  };

  const handleSaveName = async () => {
    if (!validateName(name)) return;
    if (!combo || name === combo.name) return;
    const ok = await saveCombo({ name });
    if (ok) await fetchAll();
  };

  const handleAddModel = async (model: { value?: string } | string) => {
    const value = typeof model === "string" ? model : (model?.value || "");
    if (!value || providers.includes(value)) return;
    const next = [...providers, value];
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleDeselectModel = async (model: { value?: string } | string) => {
    const value = typeof model === "string" ? model : (model?.value || "");
    if (!value || !providers.includes(value)) return;
    const next = providers.filter((p) => p !== value);
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleRemoveProvider = async (idx: number) => {
    const next = providers.filter((_, i) => i !== idx);
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleMove = async (idx: number, dir: number) => {
    const next = [...providers];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleToggleRoundRobin = async (enabled: boolean) => {
    setRoundRobin(enabled);
    if (!combo) return;
    const settingsRes = await apiGet<Settings>("/api/settings").catch(() => ({} as Settings));
    const s = settingsRes || {};
    const updated: Record<string, unknown> = { ...((s.comboStrategies as Record<string, unknown>) || {}) };
    if (enabled) updated[combo.name] = { fallbackStrategy: "round-robin" };
    else delete updated[combo.name];
    await apiPatch("/api/settings", { comboStrategies: updated });
  };

  const handleDelete = async () => {
    if (!combo || !confirm(`Delete combo "${combo.name}"?`)) return;
    await apiDelete(`/api/combos/${id}`);
    router.push(getListingHref(combo.kind || ""));
  };

  const handleTest = async () => {
    if (!combo?.kind) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    if (testResult?.audioUrl) { try { URL.revokeObjectURL(testResult.audioUrl); } catch {} }
    if (testResult?.imageUrl?.startsWith("blob:")) { try { URL.revokeObjectURL(testResult.imageUrl); } catch {} }
    const start = Date.now();
    try {
      const path = EXAMPLE_PATHS[combo.kind];
      if (!path) { setTesting(false); return; }
      const bodyFn = EXAMPLE_BODIES[combo.kind];
      if (!bodyFn) { setTesting(false); return; }
      const body = bodyFn(combo.name);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}) as Record<string, unknown>);
        const errObj = d?.error as { message?: string } | string | undefined;
        const errMsg = typeof errObj === "object" && errObj !== null ? errObj.message : (typeof errObj === "string" ? errObj : "");
        setTestError(errMsg || `HTTP ${res.status}`);
        setTestResult({ json: JSON.stringify(d, null, 2), latencyMs });
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      // Binary image
      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        setTestResult({ imageUrl: URL.createObjectURL(blob), latencyMs });
        return;
      }
      // Binary audio
      if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        const blob = await res.blob();
        setTestResult({ audioUrl: URL.createObjectURL(blob), latencyMs });
        return;
      }
      // JSON — could be image (data[0].b64_json/url) or generic
      const data = await res.json() as Record<string, unknown>;
      const first = (data?.data as Array<{ b64_json?: string; url?: string }> | undefined)?.[0];
      const imageUrl = first?.b64_json
        ? `data:image/png;base64,${first.b64_json}`
        : (first?.url || "");
      setTestResult({ json: JSON.stringify(maskB64(data), null, 2), imageUrl, latencyMs });
    } catch (e: unknown) {
      setTestError((e as Error).message || "Network error");
    }
    setTesting(false);
  };

  // Mask large b64_json strings to keep JSON view readable
  function maskB64(obj: unknown): unknown {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(maskB64);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = (k === "b64_json" && typeof v === "string" && v.length > 100)
        ? `<${v.length} chars base64>`
        : maskB64(v);
    }
    return out;
  }

  if (loading) return <div className="text-text-muted text-sm">Loading...</div>;
  if (!combo) return notFound();

  const kindLabel = KIND_LABELS[combo.kind || ""] || MEDIA_PROVIDER_KINDS.find((k) => k.id === combo.kind)?.label || "Combo";
  const examplePath = combo.kind ? EXAMPLE_PATHS[combo.kind] : undefined;
  const exampleBody = combo.kind && EXAMPLE_BODIES[combo.kind] ? EXAMPLE_BODIES[combo.kind](combo.name) : null;
  const curlExample = examplePath
    ? `curl -X POST http://localhost:20128${examplePath} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}" \\\n  -d '${JSON.stringify(exampleBody)}'`
    : "";
  const backHref = getListingHref(combo.kind || "");

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={backHref} className="text-text-muted hover:text-primary">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary">layers</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{kindLabel} Combo</p>
            <code className="text-lg font-semibold font-mono">{combo.name}</code>
          </div>
        </div>
        <Button variant="outline" icon="delete" onClick={handleDelete} className="text-red-500 border-red-200 hover:bg-red-50">
          Delete
        </Button>
      </div>

      {/* Settings Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Settings</h2>
        <div className="flex flex-col gap-4">
          <div>
            <Input label="Combo Name" value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => { setName(e.target.value); validateName(e.target.value); }} onBlur={handleSaveName} error={nameError} />
            <p className="text-[10px] text-text-muted mt-0.5">Only letters, numbers, -, _ and .</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Round Robin</p>
              <p className="text-xs text-text-muted">Rotate providers across requests instead of strict fallback order.</p>
            </div>
            <Toggle checked={roundRobin} onChange={handleToggleRoundRobin} label={undefined} description={undefined} className={undefined} size={undefined} />
          </div>
        </div>
      </Card>

      {/* Providers Card */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">Providers</h2>
            <p className="text-xs text-text-muted">Tried in order (top-down) or rotated when round-robin is on.</p>
          </div>
          <Button size="sm" icon="add" onClick={() => setShowPicker(true)}>Add Provider</Button>
        </div>
        {providers.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-border rounded-lg text-text-muted text-sm">
            No providers yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {providers.map((entry, idx) => {
              const { providerId, model } = parseModelEntry(entry);
              const p = AI_PROVIDERS[providerId] as { name?: string; color?: string; textIcon?: string } | undefined;
              return (
                <div key={`${entry}-${idx}`} className="flex items-center gap-3 p-2 rounded-lg bg-black/[0.02] dark:bg-white/[0.02]">
                  <span className="text-xs text-text-muted w-5 text-center">{idx + 1}</span>
                  <ProviderIcon
                    src={`/providers/${providerId}.png`}
                    providerId={providerId}
                    alt={p?.name || providerId}
                    size={24}
                    className="object-contain rounded shrink-0"
                    fallbackText={p?.textIcon || providerId.slice(0, 2).toUpperCase()}
                    fallbackColor={p?.color}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{p?.name || providerId}</div>
                    {model && <code className="text-[10px] text-text-muted font-mono truncate block">{model}</code>}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => handleMove(idx, -1)} disabled={idx === 0} className={`p-1 rounded ${idx === 0 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} title="Move up">
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                    <button onClick={() => handleMove(idx, 1)} disabled={idx === providers.length - 1} className={`p-1 rounded ${idx === providers.length - 1 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} title="Move down">
                      <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
                    </button>
                    <button onClick={() => handleRemoveProvider(idx)} className="p-1 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10" title="Remove">
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Test Example Card */}
      {combo.kind && examplePath && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
            <h2 className="text-lg font-semibold">Test Example</h2>
            <Button size="sm" icon="play_arrow" onClick={handleTest} disabled={testing || providers.length === 0}>
              {testing ? "Running..." : "Run"}
            </Button>
          </div>
          <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
            {curlExample}
          </pre>
          {testError && (
            <p className="mt-3 text-xs text-red-500 break-words">{testError}</p>
          )}
          {testResult && (
            <div className="mt-3 flex flex-col gap-3">
              {testResult.latencyMs != null && (
                <span className="text-[11px] text-text-muted">⚡ {testResult.latencyMs}ms</span>
              )}
              {testResult.imageUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a href={testResult.imageUrl} download="image.png" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors">
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <img src={testResult.imageUrl} alt="Generated" className="max-w-full rounded-lg border border-border" loading="lazy" decoding="async" />
                </div>
              )}
              {testResult.audioUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a href={testResult.audioUrl} download="speech.mp3" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors">
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <audio controls src={testResult.audioUrl} className="w-full" />
                </div>
              )}
              {testResult.json && (
                <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[300px] whitespace-pre-wrap break-all">
                  {testResult.json}
                </pre>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Usage Logs Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Usage Logs</h2>
        {logs.length === 0 ? (
          <p className="text-xs text-text-muted italic">No usage yet.</p>
        ) : (
          <pre className="text-[11px] font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[400px] whitespace-pre-wrap">
            {logs.join("\n")}
          </pre>
        )}
      </Card>

      {showPicker && (
        <ModelSelectModal
          isOpen={showPicker}
          onClose={() => setShowPicker(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={connections as unknown as never[]}
          selectedModel=""
          modelAliases={modelAliases}
          title={`Add ${kindLabel} Model`}
          kindFilter={(combo.kind ?? null) as null | undefined}
          addedModelValues={providers as unknown as never[]}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}
