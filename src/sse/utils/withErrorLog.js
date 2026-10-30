// Binds the error-log wrapper (src/lib/errorLog/wrap.js) to the real key lookup.
// See spec error-log.

import { createWithErrorLog } from "@/lib/errorLog/wrap.js";
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

export const withErrorLog = createWithErrorLog({ resolveKey });
