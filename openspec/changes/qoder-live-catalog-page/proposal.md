## Why

After `qoder-assistant-scene` shipped, the owner still saw no new models on `/dashboard/providers/qoder`. The server log showed the catalog was fine. DeepSeek and GLM are listed under Qoder's code names (`dmodel`, `dfmodel`, `gmodel`, `gfmodel`), next to new keys such as `qmodel_latest_preview`.

The provider page listed the static registry instead. Its names were frozen in code, it was missing new keys, and it still showed keys the account no longer has (`lite`, `performance`, `qmodel`).

## What Changes

- **The Qoder provider page lists the active account's live catalog**, like Cursor and DeepAI:
  - every key the chat router accepts, from `routableQoderModels`: the static Sonus/Cantus fallbacks, the catalog, and `enable:false` entries;
  - Qoder's own `display_name` for each key;
  - the static registry as a fallback while loading or when the fetch fails.
- **"Tải model mới nhất"** is shown for Qoder too.
- **Model ids:** the models API keeps answering `qoder/<key>`, and the page strips the prefix.
- **"Fetch Qoder Models" is removed.** It only imported catalog keys as custom models, which the live list now shows, and it could save duplicates while the list was still loading.
- **No upstream call per page load.** Loading the page reads the 1 h catalog cache that the executor shares. "Tải model mới nhất" (`?refresh=1`) forces a new read and logs the scenes.
- **Order:** live catalog first, then the static Sonus/Cantus fallbacks, then `enable:false` entries (`qoderDashboardModels`, which is unit-tested).
- **A failed read** shows "Không đọc được danh sách live…" instead of "no models".
- **Out of scope:** Qoder CN (`qoder-cn`) has no models listing on this page yet.

## Capabilities
### Modified Capabilities
- `provider-qoder` (introduced by the unarchived change `qoder-assistant-scene`; archive that change first)

## Impact
- No schema change.
- Files: `open-sse/services/qoderModels.js`, `src/app/api/providers/[id]/models/route.js`, `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `test/qoder-catalog-scenes.test.js`.
