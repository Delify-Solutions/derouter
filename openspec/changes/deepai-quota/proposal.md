## Why

DeepAI Code accounts did not appear on `/dashboard/quota`. The owner could not see an account's Theos balance, which plan each account is on, or which models are free. Free DeepAI models also had no visible way to show that they were used up. When DeepAI refused them ("Daily limit reached"), the router only applied its seconds-long 429 backoff, so it kept retrying the exhausted account. The provider page also listed only the bundled 4 models, not the account's live catalog, and had no way to re-read it.

## What Changes

- **Quota page for DeepAI** (`open-sse/services/usage/deepai.js`, registry `features.usage`):
  - The Theos bar comes from `GET /deepai_code/theos`. It is read the same way as the desktop app's "Check balance" (app v0.3.40):
    - `balance` is the Theos left;
    - `granted` is the allowance per refresh period;
    - `refresh_at` is the reset time.
  - The plan (DeepAI Pro / DeepAI Free) comes from `GET https://api.deepai.org/get_usage_summary` (`is_pro`), the app's own entitlement call. The flag stored at sign-in is the fallback.
  - The account's free and Theos-metered models come from its catalog (`theosPerRequest`, where `"0"` means free).
- **Quota card:** shows the plan label ("Gói: …") for any provider that reports a real one (not Kiro, which has its own badges; "unknown" is hidden), plus the DeepAI model summary.
- **One /theos call at a time:** the quota read shares the chat check-in's single in-flight `/theos` request (the app locks `/theos` too) and reuses an answer under 30 s old, so the two never present the same nonce.
- **Exhausted errors** (`DeepAIExecutor.parseError`): `theos_exhausted`, "Daily limit reached" and "Too many requests today" carry a reset time 30 minutes ahead (the router's maximum rate-limit cooldown).
  - The existing model lock then takes that model off that account for 30 minutes, so requests move to another account.
  - The Providers page connection row shows the lock.
  - A plain 429 (heavy load) keeps the short backoff.
- **Provider page:**
  - DeepAI shows the active account's live catalog, as Cursor does.
  - A "Tải model mới nhất" button re-reads it, bypassing the 5-minute cache (`/api/providers/:id/models?refresh=1`).
  - Each model shows a Free, "N Theos/request" or Premium badge.

## Capabilities
### Modified Capabilities
- `provider-deepai` (introduced by the unarchived change `deepai-provider`; archive that change first)

## Impact
- No schema change. No change to what customers see: `/v1/models` still exposes only ids.
- Files:
  - `open-sse/services/deepaiClient.js`, `open-sse/services/usage/deepai.js`, `open-sse/services/usage.js`, `open-sse/providers/registry/deepai.js`, `open-sse/executors/deepai.js`
  - `src/app/api/providers/[id]/models/route.js`
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `ModelRow.js`
  - `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`
  - `test/deepai-usage.test.js`
