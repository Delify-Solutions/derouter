"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Select } from "@/shared/components";
import { getProviderAlias, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";

const DEFAULT_RESPONSE_EXAMPLE = `{
  "object": "list",
  "data": [{
    "object": "embedding",
    "index": 0,
    "embedding": [0.002301, -0.019212, 0.004815, -0.031249, ...]
  }],
  "model": "...",
  "usage": { "prompt_tokens": 9, "total_tokens": 9 }
}`;

export function EmbeddingExampleCard({ providerId, customAlias }) {
  const isCustom = isCustomEmbeddingProvider(providerId);
  const providerAlias = isCustom ? (customAlias || providerId) : getProviderAlias(providerId);
  const embeddingModels = isCustom ? [] : getModelsByProviderId(providerId).filter((m) => getModelKind(m) === "embedding");

  const [selectedModel, setSelectedModel] = useState(embeddingModels[0]?.id ?? "");
  const [input, setInput] = useState("The quick brown fox jumps over the lazy dog");
  const [dimensions, setDimensions] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
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
  }, []);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : "";

  // Build request body — include dimensions only if user provided a positive number
  const buildBody = () => {
    const body = { model: modelFull, input: input.trim() };
    const dim = Number(dimensions);
    if (dimensions && Number.isFinite(dim) && dim > 0) body.dimensions = dim;
    return body;
  };

  const curlSnippet = `curl -X POST ${endpoint}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}" \\
  -d '${JSON.stringify(buildBody())}'`;

  const handleRun = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch("/api/v1/embeddings", {
        method: "POST",
        headers,
        body: JSON.stringify(buildBody()),
      });
      const latencyMs = Date.now() - start;
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message || data?.error || `HTTP ${res.status}`); return; }
      setResult({ data, latencyMs });
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  // Compact embedding array: first 4 values + count
  const formatResultJson = (data) => {
    if (!data) return DEFAULT_RESPONSE_EXAMPLE;
    const clone = JSON.parse(JSON.stringify(data));
    (clone.data || []).forEach((item) => {
      if (Array.isArray(item.embedding) && item.embedding.length > 4) {
        item.embedding = [...item.embedding.slice(0, 4).map((v) => parseFloat(v.toFixed(6))), `... (${item.embedding.length} dims)`];
      }
    });
    return JSON.stringify(clone, null, 2);
  };

  const resultJson = result ? JSON.stringify(result.data, null, 2) : "";

  return (
    <Card title="Example">
      <div className="flex flex-col gap-2.5">
        {/* Model — text input for custom node, dropdown otherwise */}
        <Row label="Model">
          {isCustom ? (
            <Input
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="e.g. voyage-3, embed-english-v3.0, text-embedding-3-small"
              inputClassName="font-mono"
            />
          ) : (
            <Select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              options={embeddingModels.map((m) => ({ value: m.id, label: m.name || m.id }))}
            />
          )}
        </Row>

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Input
              className="w-full min-w-0 flex-1"
              value={endpoint}
              onChange={(e) => useTunnel ? setTunnelEndpoint(e.target.value) : setLocalEndpoint(e.target.value)}
              inputClassName="font-mono"
              placeholder="http://localhost:3000"
            />
            {/* Tunnel toggle — only show if tunnel URL is available */}
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
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            inputClassName="font-mono"
          />
        </Row>

        {/* Input */}
        <Row label="Input">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onClear={() => setInput("")}
          />
        </Row>

        {/* Dimensions (optional) — truncate embedding vector length */}
        <Row label="Dimensions">
          <Input
            type="number"
            min="1"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="optional, e.g. 512, 1024 (leave empty for default)"
          />
        </Row>

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
                disabled={!input.trim() || !modelFull}
                onClick={handleRun}
              >
                {running ? "Running..." : "Run"}
              </Button>
            </div>
          </div>
          <pre className="bg-vx-page rounded-vx-md px-3 py-2.5 text-xs font-mono text-vx-text overflow-x-auto whitespace-pre-wrap break-all">{curlSnippet}</pre>
        </div>

        {/* Error */}
        {error && <p className="text-xs text-vx-danger break-words">{error}</p>}

        {/* Response — default example or real result */}
        <div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-vx-text-muted uppercase tracking-wider">
              Response {result && <span className="font-normal normal-case">&#9889; {result.latencyMs}ms</span>}
            </span>
            {result && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={copiedRes ? "check" : "content_copy"}
                onClick={() => copyRes(resultJson)}
              >
                {copiedRes ? "Copied" : "Copy"}
              </Button>
            )}
          </div>
          <pre className="bg-vx-page rounded-vx-md px-3 py-2.5 text-xs font-mono text-vx-text overflow-x-auto whitespace-pre-wrap break-all opacity-70">
            {formatResultJson(result?.data)}
          </pre>
        </div>
      </div>
    </Card>
  );
}
