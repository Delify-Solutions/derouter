import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  enforceKeyAccess,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { canonicalComboName } from "@/lib/db/repos/combosRepo.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { modelNotFoundMessage, markPlatform } from "@/lib/auth/platformError";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveApiKeyOwner } from "@/lib/db/repos/billingRepo.js";
import { resolvePrice } from "@/lib/db/repos/pricingRepo.js";
import { admitSync } from "@/lib/billing/planQueue.js";
import { costFromImagesNano } from "@/shared/utils/money";
import { withErrorLog } from "../utils/withErrorLog.js";
import { getRequestIp } from "@/lib/auth/clientIp.js";
import { publicModelContextSync, maskOptionsFor, isCustomerKeySync, hideUpstreamModelsEnabled } from "@/lib/models/customerModels.js";
import { maskResponse } from "@/lib/models/publicModel.js";
import {
  getStorageRowSync,
  imageStorageForUserSync,
  recordStorageResultSync,
  rehostImageBody,
  uploadImage,
} from "@/lib/storage/userStorage.js";
import { notifyAdmin } from "@/lib/notify/telegram.js";
import { localImageBaseUrl } from "@/lib/storage/localImages.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

const IMAGE_ENDPOINT = "/v1/images/generations";

/**
 * A customer key must not get a free image. Two ways to pay exist, so the model is
 * served when EITHER applies:
 *
 *   * it has a per-image price (credit is charged at that price), or
 *   * the customer holds an image purchase that admission would pick — an image
 *     plan sells images, not dollars, so its price is irrelevant.
 *
 * Admin and local keys (no owning customer) are not billed and are never refused.
 * Returns an error Response, or null when the call may proceed.
 */
async function refuseUnpricedImage(apiKey, { provider, model, requestedModel }) {
  if (!apiKey) return null;
  const db = await getAdapter();
  const owner = resolveApiKeyOwner(db, apiKey);
  if (!owner) return null;
  const { pricing } = await resolvePrice({ provider, model, requestedModel });
  if (costFromImagesNano(1, pricing) > 0) return null;
  // An image purchase pays in images, so no per-image price is needed for it. A
  // key pinned to a plan is scoped to that plan, exactly like admission — so the
  // pin is read from the key row (a deleted key keeps it in its tombstone).
  const pinnedPlanId = owner.deleted
    ? owner.planId ?? null
    : db.get(`SELECT planId FROM apiKeys WHERE id = ?`, [owner.apiKeyId])?.planId ?? null;
  // The model matters here as much as on the text path: a purchase that does not
  // include this image combo cannot pay for it (spec plan-model-access).
  const admitted = admitSync(db, owner.userId, null, {
    planId: pinnedPlanId,
    requestKind: "image",
    model: requestedModel || model,
  });
  if (admitted.ok && admitted.kind === "image") return null;
  // A router decision, not an upstream error: platform-marked so a customer
  // reads it as written (spec model-privacy).
  return markPlatform(errorResponse(
    HTTP_STATUS.FORBIDDEN,
    `Image model "${requestedModel || model}" has no per-image price, so it is not available on this key`
  ));
}

/**
 * Record a finished image request so it is priced and charged like any other.
 * With a `sink` the record waits there: a customer's images are charged only once
 * they reached the customer's storage (finishImage).
 */
function recordImageUsage(args, sink = null) {
  if (sink) {
    sink.push(args);
    return;
  }
  saveImageUsage(args);
}

function saveImageUsage({ provider, model, connectionId = null, apiKey, requestedModel, result, clientIp = null }) {
  if (!apiKey) return;
  saveRequestUsage({
    provider,
    model,
    connectionId,
    apiKey,
    endpoint: IMAGE_ENDPOINT,
    tokens: {},
    imageCount: Math.max(1, Number(result?.imageCount) || 0),
    status: "success",
    requestedModel,
    clientIp,
  }).catch(() => {});
}

/**
 * The storage a customer key's images go to (spec image-storage): the router's
 * disk for customers the admin picked, else the customer's own, else the system
 * storage when the admin enabled one. Admin and
 * local keys have none and are served as before. A customer with neither is
 * refused before any upstream call.
 * @returns {Promise<null | { userId: string, system: boolean, local: boolean, config: object } | { error: Response }>}
 *   `userId` is the storage row's id (SYSTEM_STORAGE_ID for the system storage).
 */
async function resolveCustomerStorage(apiKey, { baseUrl = "" } = {}) {
  if (!apiKey) return null;
  const db = await getAdapter();
  const owner = resolveApiKeyOwner(db, apiKey);
  if (!owner?.userId) return null;
  const usable = imageStorageForUserSync(db, owner.userId, { baseUrl });
  if (usable.error) return { error: markPlatform(errorResponse(HTTP_STATUS.FORBIDDEN, usable.error)) };
  return { userId: usable.id, system: usable.system, local: Boolean(usable.local), config: usable.config };
}

/** Mark a storage failing; the admin hears about the system storage going down (once). */
async function markStorageFailing(storage, reason, { notify = notifyAdmin } = {}) {
  const db = await getAdapter();
  const wasOk = storage.system && Number(getStorageRowSync(db, storage.userId)?.lastTestOk) === 1;
  recordStorageResultSync(db, storage.userId, { ok: false, error: reason });
  if (wasOk) {
    Promise.resolve(notify(
      `⚠️ <b>CDN ảnh hệ thống lỗi</b>\nKhông lưu được ảnh: ${String(reason).replace(/[<>&]/g, "")}\n` +
      `Khách không có CDN riêng sẽ bị từ chối model ảnh cho tới khi bạn bấm "Kiểm tra lại" ở /dashboard/storage.`
    )).catch(() => {});
  }
}

/**
 * Hand a successful response to the customer: every image is uploaded to their
 * storage and the links are rewritten, so the upstream's link never leaves the
 * router. Usage is saved only then. A failure is free only while no image byte
 * reached the customer's endpoint: that endpoint is theirs, so "stored, then
 * answered an error" must not turn into a free image. The system storage and the
 * router's disk are the router's own, so a failure there is always free.
 */
async function finishImage(response, { storage, usage, binaryOutput }, { rehost = rehostImageBody, upload = uploadImage } = {}) {
  const flush = () => usage.splice(0).forEach(saveImageUsage);
  if (!storage || !response?.ok) {
    flush();
    return response;
  }
  const fail = async (reason, { charge: sentToCustomer = false, storageFault = false } = {}) => {
    const routerOwned = storage.system || storage.local;
    const charge = sentToCustomer && !routerOwned;
    if (charge) flush();
    else usage.splice(0);
    const billing = charge
      ? "Ảnh đã được gửi tới CDN của bạn nên lượt này vẫn tính phí."
      : "Lượt này không bị tính phí.";
    if (!storageFault) {
      // The upstream's fault (no image, unreadable, too large): the storage is fine.
      return markPlatform(errorResponse(HTTP_STATUS.BAD_GATEWAY, `Không nhận được ảnh hợp lệ từ model: ${reason}. ${billing}`));
    }
    if (storage.local) {
      log.error("IMAGE", `Local image store failed: ${reason}`);
    } else {
      try {
        // The storage must pass a test again before the next image request.
        await markStorageFailing(storage, reason);
      } catch { /* the page shows the last error; losing it is not worth a failure */ }
    }
    if (routerOwned) {
      // The reason is about the router's own bucket or disk: not the customer's business.
      // A CDN of their own only helps on the system storage: local storage overrides it.
      const way = storage.local ? "" : ", hoặc kết nối CDN riêng ở /account/storage";
      return markPlatform(errorResponse(
        HTTP_STATUS.BAD_GATEWAY,
        `Ảnh đã tạo nhưng hệ thống tạm thời không lưu được ảnh. ${billing} Vui lòng thử lại sau${way}.`
      ));
    }
    return markPlatform(errorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      `Ảnh đã tạo nhưng không lưu được lên CDN của bạn: ${reason}. Kiểm tra cấu hình ở /account/storage. ${billing}`
    ));
  };
  try {
    const type = response.headers.get("content-type") || "";
    if (binaryOutput && !type.includes("json")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const uploaded = await upload(storage.config, bytes);
      if (!uploaded.ok) return fail(uploaded.error, { charge: uploaded.sent, storageFault: uploaded.storageFault });
      flush();
      const headers = new Headers(response.headers);
      headers.set("X-Image-Url", uploaded.url);
      headers.append("Access-Control-Expose-Headers", "X-Image-Url");
      return new Response(bytes, { status: response.status, headers });
    }
    const body = await response.json();
    const rehosted = await rehost(body, storage.config);
    if (!rehosted.ok) return fail(rehosted.error, { charge: rehosted.charge, storageFault: rehosted.storageFault });
    flush();
    return new Response(JSON.stringify(rehosted.body), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch {
    return fail("không đọc được kết quả tạo ảnh");
  }
}

/**
 * Handle image generation request
 * @param {Request} request
 */
async function handleImageGenerationRequestInner(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = await canonicalComboName(body.model);
  // The response is masked with the combo's own name and members, so the name must be
  // the canonical spelling: `pic-combo` has to find `Pic-Combo`'s members to hide.
  ctx.publicName = typeof modelStr === "string" ? modelStr : null;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return markPlatform(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key"));
    const valid = await isValidApiKey(apiKey);
    if (!valid) return markPlatform(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"));
  }

  // Advanced key limits: RPM/TPM/expiry/budget + model allow-list. `requestKind`
  // tells admission this request is billed in images, so an image purchase may pay
  // for it (and is preferred over credit).
  if (apiKey) {
    const denied = await enforceKeyAccess(apiKey, modelStr, {
      clientIp: getRequestIp(request),
      requestKind: "image",
    });
    if (denied) return denied;
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  const storage = await resolveCustomerStorage(apiKey, { baseUrl: localImageBaseUrl(request, settings) });
  if (storage?.error) return storage.error;
  // The images must be complete before they can be uploaded, so a customer's
  // request is never streamed.
  const stream = storage ? false : wantsStream;
  const usage = [];

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    const response = await handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream: stream, binaryOutput, preferredConnectionId, apiKey, requestedModel: modelStr, clientIp: getRequestIp(request), usage }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
    return finishImage(response, { storage, usage, binaryOutput });
  }

  const response = await handleSingleModelImage(body, modelStr, {
    wantsStream: stream,
    binaryOutput,
    preferredConnectionId,
    apiKey,
    requestedModel: modelStr.includes("/") ? null : modelStr,
    clientIp: getRequestIp(request),
    usage,
  });
  return finishImage(response, { storage, usage, binaryOutput });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey = null, requestedModel = null, clientIp = null, usage = null } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  const unpriced = await refuseUnpricedImage(apiKey, { provider, model, requestedModel });
  if (unpriced) return unpriced;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) {
      recordImageUsage({ provider, model, apiKey, requestedModel, result, clientIp }, usage);
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return ((modelInfo.inferred || modelInfo.unknownProvider)
          ? errorResponse(HTTP_STATUS.NOT_FOUND, modelNotFoundMessage(modelStr))
          : errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`));
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) {
      recordImageUsage({ provider, model, connectionId: credentials.connectionId, apiKey, requestedModel, result, clientIp }, usage);
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
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
 * Image generation with the response masked for customer keys (spec
 * model-privacy): errors read "[provider/model] …" and "No credentials for
 * provider: …" otherwise. Binary image output is never touched.
 */
async function handleImageGenerationRequest(request) {
  const ctx = {};
  const response = await handleImageGenerationRequestInner(request, ctx);
  const apiKey = extractApiKey(request);
  if (!ctx.publicName || !apiKey) return response;
  // Admin keys skip the lookups below entirely.
  try {
    if (!hideUpstreamModelsEnabled(await getSettings()) || !isCustomerKeySync(await getAdapter(), apiKey)) return response;
  } catch { /* unknown: fall through and mask (fail closed) */ }
  const members = (await getComboModels(ctx.publicName).catch(() => null)) || [];
  const info = await getModelInfo(ctx.publicName).catch(() => null);
  const upstream = info?.provider ? [info.model, `${info.provider}/${info.model}`] : [];
  const providers = info?.provider ? [info.provider] : [];
  let masking = null;
  try {
    masking = publicModelContextSync(await getAdapter(), await getSettings(), {
      apiKey, publicName: ctx.publicName, members, upstream, providers,
    });
  } catch {
    masking = maskOptionsFor({ publicName: ctx.publicName, members, upstream, providers });
  }
  return masking ? maskResponse(response, masking) : response;
}

export const handleImageGeneration = withErrorLog(handleImageGenerationRequest, { cloneBody: true });

// Test seam: the storage gate and the re-hosting step, without a full request.
export const imageStorageForTests = { resolveCustomerStorage, finishImage, markStorageFailing };
