import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "dr-cli-auth";

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    // Pick a key unlikely to be denied: no per-key allowedModels, no group (groups
    // can carry their own allowedModels), and not expired. Falls back to the first
    // active key if nothing unrestricted exists.
    const active = keys.filter((k) => k.isActive !== false);
    const notExpired = (k) => {
      if (!k.expiresAt) return true;
      try { return new Date(k.expiresAt).getTime() > Date.now(); } catch { return true; }
    };
    apiKey = (active.find((k) => notExpired(k) && !k.groupId
      && (!k.allowedModels || (Array.isArray(k.allowedModels) && k.allowedModels.length === 0)))
      || active.find((k) => notExpired(k) && (!k.allowedModels || (Array.isArray(k.allowedModels) && k.allowedModels.length === 0)))
      || active.find(notExpired)
      || active[0])?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-dr-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`) {
  const headers = await getInternalHeaders();
  const start = Date.now();
  const redactedKey = headers["Authorization"] ? `Bearer ${headers["Authorization"].replace("Bearer ", "").slice(0, 8)}…` : "none";
  console.log(`[TEST-MODEL] → kind=${kind} model=${model} key=${redactedKey}`);

  if (kind === "embedding") {
    const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    console.log(`[TEST-MODEL] ← model=${model} status=${res.status} latency=${latencyMs}ms body=${rawText.slice(0, 300)}`);
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetch(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetch(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  const chatBody = JSON.stringify({
    model,
    max_tokens: 1024,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  });
  const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers,
    body: chatBody,
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;

  const rawText = await res.text().catch(() => "");
  console.log(`[TEST-MODEL] ← model=${model} status=${res.status} latency=${latencyMs}ms body=${rawText.slice(0, 300)}`);
  let parsed = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
    return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
  }

  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
    };
  }

  if (parsed?.error) {
    const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: String(providerError).slice(0, 240),
    };
  }

  const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;

  // Soft-pass (issue #3010): a reasoning model may burn its whole budget on
  // chain-of-thought and return finish_reason:"length" with empty content but
  // non-empty reasoning/thinking. That's a successful connection, not a failure.
  const firstChoice = parsed?.choices?.[0] || {};
  const hasReasoning =
    firstChoice.message?.reasoning ||
    firstChoice.message?.reasoning_content ||
    firstChoice.message?.thinking ||
    firstChoice.message?.thinking_content;
  const contentEmpty = !String(firstChoice.message?.content || "").trim();
  if (hasChoices && firstChoice.finish_reason === "length" && contentEmpty && hasReasoning) {
    return { ok: true, latencyMs, error: null, status: res.status, note: "reasoning-only response (length-limited)", content: String(firstChoice.message?.content || "") };
  }

  if (!hasChoices) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: "Provider returned no completion choices for this model",
    };
  }

  return { ok: true, latencyMs, error: null, status: res.status, content: String(parsed?.choices?.[0]?.message?.content || "") };
}
