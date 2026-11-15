## Why

Image generation exists (`POST /v1/images/generations`, combo `kind: "image"`, a per-image price on the combo), but there is no way to **sell** it. Every sale is a credit pool: a plan stores `creditNanoUsd`, a purchase stores `creditTotalNanoUsd`, and the queue spends it by token price. An image therefore has to be paid as if it were a token request — which forces the owner to price an image plan in dollars and to hope the per-image price and the credit pool land where the margin was planned. The owner wants to sell "100 ảnh" as its own product with its own price, and to have image spend be a separate budget that a text request cannot touch.

## What Changes

- **A plan is one of two kinds**: `llm` (credit, today's behaviour and the default for every existing row) or `image` (a count of generated images). `kind` lives on `plans`, on `orders` (snapshot at sale, so editing a template later cannot change what was sold) and on `userPlans` (per purchase).
- **An image plan stores images, not dollars**: `imageCount` on the template, `imageTotal`/`imageRemaining` on the purchase, and `creditNanoUsd` is forced to 0. The two pools never mix: credit cannot buy an image-plan's images and images cannot be turned into credit.
- **The queue is kind-scoped for admission**:
  - a token request is paid only by `kind = 'llm'` purchases;
  - an image request prefers `kind = 'image'` purchases and falls back to `kind = 'llm'` purchases at the combo's per-image price, so today's credit customers keep generating images.
- **Charging is unit-aware**. An image request paid by an image purchase subtracts images (`imageCount` of them, one per returned image) and moves no money: the combo's per-image price is *upstream cost*, not what the customer pays. Paid by a credit purchase it subtracts `perImagePrice × images` from credit exactly as before, overdraft and all.
- **Windows are unit-aware**: `userPlanWindows.spentImages` counts images for an image plan; `spentNanoUsd` stays 0. `limits[].maxImages` replaces `maxNanoUsd` as the ceiling, and an image limit reads "Tối đa 20 ảnh mỗi 5 giờ".
- **The ledger carries images**: `creditLedger.deltaImages` / `balanceAfterImages`, written only by image-plan rows. Granting, charging, expiring and revoking an image purchase all write an image movement and no dollar movement.
- **An image plan cannot be unlimited or open-amount**: `unlimitedCredit` and `allowCustomAmount` are refused with a message that says why. An image plan always sells a fixed count for a fixed term.
- **Customer and admin surfaces show images as images**: the ledger labels and amounts move images on an image-plan row ("Được cấp ảnh", "+100 ảnh", "40 ảnh") instead of printing "$0.00", the inactive-plan tab says "Hết ảnh", the admin purchase history shows the image count, and the admin limits/revoke dialogs edit and describe the purchase in images.
- **Sales surfaces show images as images**: the landing plan card says "100 ảnh" instead of a dollar credit figure; the landing catalogue has a per-image price table (a token table cannot express "no tokens"); the pricing model list splits text and image combos; the buy card, queue card, plan meters and account overview show an image balance next to credit.
- **The admin form switches kind**: choosing "Gói ảnh" replaces the credit price with an image count, the limits editor switches to images in each row, and the preview reads in images.
- **Groups may allow image combos**: the allow-list picker lists text *and* image combos, so an image plan's models can be enabled for the group that buys it.

## Capabilities

### Added Capabilities
- `image-plans`: a plan that sells a count of generated images instead of credit.

### Modified Capabilities
- `plan-templates`: a plan has a `kind`; an image plan stores a count and refuses credit-only and count-only fields that contradict its kind.
- `plan-queue-billing`: admission is kind-scoped; an image charge subtracts images, not credit.
- `plan-terms`: windows and limits are measured in the unit the plan sells.
- `customer-groups`: image combos are part of an allow-list.
- `public-landing`: an image plan is a card with an image count, and image models get a per-image price table.
- `customer-portal`: credit and image balances are shown separately; an image request reports images.
- `api-access-enforcement`: an image request is admitted and charged as an image request.

## Impact

- **Code**: `src/lib/billing/planKind.js` (new, pure), `limits.js`, `planQueue.js`, `grants.js`, `orders.js`, `adminActions.js`, `ledger.js`, `rates.js`, `unpricedModels.js`, `src/lib/db/repos/{billingRepo,giftRepo,accountPlansRepo,usageRepo}.js`, `src/lib/auth/keyEnforcement.js`, `src/lib/payments/checkout.js`, `src/sse/handlers/imageGeneration.js`, `src/sse/services/auth.js`, the admin plan form and cards, the customer plans page, buy cards, queue card, limit meters, account overview, landing plan card/catalogue/pricing, and the group allow-list picker.
- **Database**: `plans.kind` / `plans.imageCount`, `orders.kind` / `orders.imageCount`, `userPlans.kind` / `imageTotal` / `imageRemaining`, `userPlanWindows.spentImages`, `creditLedger.deltaImages` / `balanceAfterImages`; `SCHEMA_VERSION` 31 → 32. Additive only, no data migration: every existing row reads as `kind = 'llm'` with 0 images.
- **API**: plan payloads gain `kind` and `imageCount`; queue entries gain `kind`, `imageTotal` and `imageRemaining`; the account overview gains `availableImages`.
- **Behaviour change for the owner**: an image plan must have a positive whole `imageCount` and a credit plan must have credit — a plan created with the wrong kind's fields is rejected rather than silently zeroed.
- **Out of scope**: pricing an image differently per size or quality, image *input* (edits) as a separate unit, partial-image refunds, an image plan that also carries credit, and per-model image limits.
