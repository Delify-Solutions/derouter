import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  enforceKeyAccess,
  refuseUnpricedModelResponse,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { modelNotFoundMessage, markPlatform } from "@/lib/auth/platformError";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { withErrorLog } from "../utils/withErrorLog.js";
import { getRequestIp } from "@/lib/auth/clientIp.js";
import { getAdapter } from "@/lib/db/driver.js";
import { publicModelContextSync, maskOptionsFor } from "@/lib/models/customerModels.js";
import { maskResponse } from "@/lib/models/publicModel.js";
import { embeddingUsage } from "open-sse/utils/embeddingUsage.js";

/**
 * Handle embeddings request for the SSE/Next.js server.
 * Follows the same auth + fallback pattern as handleChat.
 *
 * @param {Request} request
 */
async function handleEmbeddingsRequestInner(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("EMBEDDINGS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return markPlatform(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key"));
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return markPlatform(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"));
    }
  }

  // Advanced key limits: RPM/TPM/expiry/budget + model allow-list.
  if (apiKey) {
    const denied = await enforceKeyAccess(apiKey, modelStr, { clientIp: getRequestIp(request) });
    if (denied) return denied;
  }

  if (!modelStr) {
    log.warn("EMBEDDINGS", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  if (!body.input) {
    log.warn("EMBEDDINGS", "Missing input");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    log.warn("EMBEDDINGS", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  // For the customer response mask (spec model-privacy): what was asked, and
  // the ids that name the provider/model behind it.
  ctx.publicName = modelStr;
  ctx.upstream = [model, `${provider}/${model}`];
  ctx.providers = [provider];

  // Customer keys pay per token: an unpriced embedding model would be free.
  if (apiKey) {
    const unpriced = await refuseUnpricedModelResponse(apiKey, {
      provider, model, requestedModel: modelStr.includes("/") ? null : modelStr, clientIp: getRequestIp(request),
    });
    if (unpriced) return unpriced;
  }

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Credential + fallback loop (mirrors handleChat)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("EMBEDDINGS", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${provider}`);
        return ((modelInfo.inferred || modelInfo.unknownProvider)
          ? errorResponse(HTTP_STATUS.NOT_FOUND, modelNotFoundMessage(modelStr))
          : errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`));
      }
      log.warn("EMBEDDINGS", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleEmbeddingsCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) {
      // The upstream's exact count, or an estimate from the input when it reported
      // none (Gemini always answers zeros): an embedding is never served free.
      const usage = embeddingUsage(result.usage, body.input);
      if (usage) {
        saveRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: usage.tokens,
          estimated: usage.estimated,
          status: "success",
          clientIp: getRequestIp(request),
          // Original client model (bare combo name when the request was for a combo);
          // used to resolve a combo-level price override before falling back to per-pool.
          requestedModel: modelStr && !modelStr.includes("/") ? modelStr : null,
        }).catch(() => {});
      }
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}

// Failed requests are kept in the error log (spec error-log); the body is read back through a clone.
/**
 * Embeddings with the response masked for customer keys (spec model-privacy):
 * the `model` field names what the customer asked for, and errors never name the
 * provider (they read "[provider/model] …" otherwise).
 */
async function handleEmbeddingsRequest(request) {
  const ctx = {};
  const response = await handleEmbeddingsRequestInner(request, ctx);
  const apiKey = extractApiKey(request);
  if (!ctx.publicName || !apiKey) return response;
  let masking = null;
  try {
    masking = publicModelContextSync(await getAdapter(), await getSettings(), {
      apiKey, publicName: ctx.publicName, upstream: ctx.upstream, providers: ctx.providers,
    });
  } catch {
    masking = maskOptionsFor({ publicName: ctx.publicName, upstream: ctx.upstream, providers: ctx.providers });
  }
  return masking ? maskResponse(response, masking) : response;
}

export const handleEmbeddings = withErrorLog(handleEmbeddingsRequest, { cloneBody: true });
