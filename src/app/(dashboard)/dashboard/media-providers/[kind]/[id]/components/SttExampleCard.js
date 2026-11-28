"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Select } from "@/shared/components";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";

export function SttExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);
  const builtinSttModels = getModelsByProviderId(providerId).filter((m) => getModelKind(m) === "stt");
  const [customSttModels, setCustomSttModels] = useState([]);
  const sttModels = [...builtinSttModels, ...customSttModels];

  const [selectedModel, setSelectedModel] = useState(builtinSttModels[0]?.id ?? "");
  const selectedModelObj = sttModels.find((m) => m.id === selectedModel);
  const allowedParams = Array.isArray(selectedModelObj?.params) ? selectedModelObj.params : [];

  const [audioFile, setAudioFile] = useState(null);
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [responseFormat, setResponseFormat] = useState("json");
  const [temperature, setTemperature] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [latency, setLatency] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const { copied: copiedCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, copy: copyRes } = useCopyToClipboard();

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => { setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || ""); })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => { if (d.publicUrl) setTunnelEndpoint(d.publicUrl); })
      .catch(() => {});
    const loadCustom = () => {
      fetch("/api/models/custom", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const list = (d.models || []).filter((m) => getModelKind(m) === "stt" && m.providerAlias === providerAlias);
          setCustomSttModels(list);
        })
        .catch(() => {});
    };
    loadCustom();
    window.addEventListener("focus", loadCustom);
    window.addEventListener("customModelChanged", loadCustom);
    return () => {
      window.removeEventListener("focus", loadCustom);
      window.removeEventListener("customModelChanged", loadCustom);
    };
  }, [providerAlias]);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : "";

  const curlSnippet = `curl -X POST ${endpoint}/v1/audio/transcriptions \\
  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}" \\
  -F "file=@${audioFile?.name || "audio.mp3"}" \\
  -F "model=${modelFull}"${allowedParams.includes("language") && language ? ` \\\n  -F "language=${language}"` : ""}${allowedParams.includes("response_format") ? ` \\\n  -F "response_format=${responseFormat}"` : ""}${allowedParams.includes("temperature") && temperature ? ` \\\n  -F "temperature=${temperature}"` : ""}${allowedParams.includes("prompt") && prompt ? ` \\\n  -F "prompt=${prompt}"` : ""}`;

  const handleRun = async () => {
    if (!audioFile || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    // Runs inside the async click handler, never during render.
    // eslint-disable-next-line react-hooks/purity
    const start = Date.now();
    try {
      const fd = new FormData();
      fd.append("file", audioFile);
      fd.append("model", modelFull);
      if (allowedParams.includes("language") && language) fd.append("language", language);
      if (allowedParams.includes("response_format")) fd.append("response_format", responseFormat);
      if (allowedParams.includes("temperature") && temperature) fd.append("temperature", temperature);
      if (allowedParams.includes("prompt") && prompt) fd.append("prompt", prompt);

      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch("/api/v1/audio/transcriptions", { method: "POST", headers, body: fd });
      // Runs inside the async click handler, never during render.
      // eslint-disable-next-line react-hooks/purity
      setLatency(Date.now() - start);
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("application/json") ? await res.json() : await res.text();
      if (!res.ok) {
        setError(data?.error?.message || data?.error || data || `HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const resultStr = typeof result === "string" ? result : (result ? JSON.stringify(result, null, 2) : `{\n  "text": "Hello world..."\n}`);

  return (
    <Card title="Example">
      <div className="flex flex-col gap-2.5">
        {/* Model */}
        {sttModels.length > 0 ? (
          <Row label="Model">
            <Select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              options={sttModels.map((m) => ({ value: m.id, label: m.name || m.id }))}
            />
          </Row>
        ) : (
          <Row label="Model">
            <Input
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="Enter model id"
              inputClassName="font-mono"
            />
          </Row>
        )}

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <span className="w-full min-w-0 flex-1 px-3 py-1.5 text-sm font-mono text-vx-text bg-vx-page rounded-vx-md truncate">
              {endpoint}/v1/audio/transcriptions
            </span>
            {tunnelEndpoint && (
              <Button
                type="button"
                size="sm"
                variant={useTunnel ? "primary-outline" : "light-outline"}
                icon="wifi_tethering"
                className="shrink-0"
                title={useTunnel ? "Using tunnel" : "Using local"}
                onClick={() => setUseTunnel((v) => !v)}
              >
                Tunnel
              </Button>
            )}
          </div>
        </Row>

        {/* API Key */}
        <Row label="API Key">
          <span className="px-3 py-1.5 text-sm font-mono text-vx-text bg-vx-page rounded-vx-md truncate block">
            {apiKey ? `${apiKey.slice(0, 8)}${"•".repeat(Math.min(20, Math.max(0, apiKey.length - 8)))}` : <span className="text-vx-text-muted italic">No key configured</span>}
          </span>
        </Row>

        {/* Audio file */}
        <Row label="Audio File">
          <div className="flex flex-col gap-2">
            <input
              type="file"
              accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.flac,.webm,.opus"
              onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
              className="w-full text-xs text-vx-text-muted file:mr-2 file:py-1 file:px-2.5 file:rounded-vx-md file:border file:border-vx-border file:bg-vx-surface file:text-vx-text hover:file:bg-vx-surface-2 file:cursor-pointer"
            />
            {audioFile && (
              <span className="text-xs text-vx-text-muted font-mono">
                {audioFile.name} · {(audioFile.size / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
        </Row>

        {/* Language (if model supports) */}
        {allowedParams.includes("language") && (
          <Row label="Language">
            <Input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="e.g. en, vi, ja (auto-detect if empty)"
              inputClassName="font-mono"
            />
          </Row>
        )}

        {/* Prompt (if model supports) */}
        {allowedParams.includes("prompt") && (
          <Row label="Prompt">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="optional context to improve accuracy"
            />
          </Row>
        )}

        {/* Temperature (if model supports) */}
        {allowedParams.includes("temperature") && (
          <Row label="Temperature">
            <Input
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0 - 1 (default 0)"
            />
          </Row>
        )}

        {/* Response format (if model supports) */}
        {allowedParams.includes("response_format") && (
          <Row label="Response Format">
            <Select
              value={responseFormat}
              onChange={(e) => setResponseFormat(e.target.value)}
              options={[
                { value: "json", label: "json" },
                { value: "text", label: "text" },
                { value: "srt", label: "srt" },
                { value: "verbose_json", label: "verbose_json" },
                { value: "vtt", label: "vtt" },
              ]}
            />
          </Row>
        )}

        {/* Curl + Run */}
        <div className="mt-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-vx-text-muted uppercase tracking-wider">Request</span>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={copiedCurl ? "check" : "content_copy"}
                onClick={() => copyCurl(curlSnippet)}
              >
                {copiedCurl ? "Copied" : "Copy"}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                icon="play_arrow"
                loading={running}
                disabled={!audioFile || !modelFull}
                onClick={handleRun}
              >
                {running ? "Transcribing..." : "Run"}
              </Button>
            </div>
          </div>
          <pre className="bg-vx-page rounded-vx-md px-3 py-2.5 text-xs font-mono text-vx-text overflow-x-auto whitespace-pre-wrap break-all">{curlSnippet}</pre>
        </div>

        {error && <p className="text-xs text-vx-danger break-words">{error}</p>}

        {/* Response */}
        <div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-vx-text-muted uppercase tracking-wider">
              Response {result && latency && <span className="font-normal normal-case">&#9889; {latency}ms</span>}
            </span>
            {result && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={copiedRes ? "check" : "content_copy"}
                onClick={() => copyRes(resultStr)}
              >
                {copiedRes ? "Copied" : "Copy"}
              </Button>
            )}
          </div>
          <pre className="bg-vx-page rounded-vx-md px-3 py-2.5 text-xs font-mono text-vx-text overflow-x-auto whitespace-pre-wrap break-all opacity-70">
            {resultStr}
          </pre>
        </div>
      </div>
    </Card>
  );
}
