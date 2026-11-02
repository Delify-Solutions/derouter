// Binds the error-log wrapper (src/lib/errorLog/wrap.js) to the real key lookup.
// See spec error-log.

import { createWithErrorLog } from "@/lib/errorLog/wrap.js";
import { withInflightScope } from "@/lib/billing/inflight.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getUserById } from "@/lib/db/repos/userRepo.js";
import { extractApiKey } from "../services/auth.js";

/** Who made the request: the key id plus a readable label, never the key itself. */
async function resolveKey(request) {
  try {
    const raw = extractApiKey(request);
    if (!raw) return null;
    const key = await getApiKeyByKey(raw);
    if (!key) return null;
    let owner = key.name || "API key";
    if (key.userId) {
      const user = await getUserById(key.userId);
      if (user?.email) owner = user.email;
    }
    return { apiKeyId: key.id, owner };
  } catch {
    return null;
  }
}

const withErrorLogOnly = createWithErrorLog({ resolveKey });

// Every LLM handler goes through here, so this is also where a request gets its
// concurrency scope: a customer slot taken during enforcement is released when
// the response body finishes (src/lib/billing/inflight.js).
export function withErrorLog(handler, opts) {
  return withInflightScope(withErrorLogOnly(handler, opts));
}
