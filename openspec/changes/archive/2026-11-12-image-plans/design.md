## Context

Image generation shipped as a *billing variant of a chat request*: a combo tagged `kind: "image"`, a per-image price on the combo, and `POST /v1/images/generations` charging `perImagePrice × images` through the same queue as a token request. That works when the customer holds credit. It does not let the owner sell "100 ảnh" as a product, because there is nowhere to store "100 ảnh".

The constraint that shapes everything below: **a credit balance is money and an image balance is a count.** They cannot share a column, cannot be converted, and a rounding rule in one must never be reachable from the other.

## Goals / Non-Goals

**Goals**
- Sell a plan in images with its own price, duration and per-window limits.
- Keep every existing plan, purchase, order and ledger row readable and unchanged in behaviour.
- Let a credit customer keep generating images at the per-image price, with no migration step.
- One implementation of "what does this purchase pay for" shared by admission, charging, the queue page, the admin cards and the customer cards.

**Non-Goals**
- Converting credit into images or the reverse.
- Pricing an image by size, quality or step count.
- Image *edits* (input images) as a separate unit.
- Selling a plan that carries both credit and images.

## Decisions

### D1 — `kind` on the plan, snapshot on the order and the purchase
`plans.kind` says what the template sells; `orders.kind` and `userPlans.kind` say what a specific sale sold. An admin switching a template between kinds must not rewrite what a buyer already holds, and an order pending when the switch happens must grant what the buyer paid for. `normalizePlanKind` maps `NULL`/anything unknown to `llm`, so every pre-existing row reads as today.

### D2 — Two balance columns, never one
`imageTotal`/`imageRemaining` are integers; `creditTotalNanoUsd`/`creditRemainingNanoUsd` stay exactly what they were. An image purchase stores 0 credit and an image grant skips the debt-paydown step entirely, because paying debt with images would invent an exchange rate nobody set.

Alternative rejected: one `balance` column with a unit tag. It forces every query, sum and UI to branch, and any missed branch adds dollars to images.

### D3 — Admission prefers the matching kind, never mixes
A token request is paid only by credit purchases: an image plan's images are not money and cannot be spent on tokens. An image request is paid by an image purchase first — that is what it was sold for — and falls back to credit at the per-image price, which is what keeps today's customers generating images after the upgrade.

Alternative rejected: image purchases first for *all* requests. It would let a customer buy a cheap image plan and get text for free, because an image plan has no token price.

### D4 — Images are charged before the money passes
`chargeSync` takes the image share first, then drops the covered share of the cost (`floor(C × taken / I)`), then runs the two money passes. Ordering matters: if money went first, a customer holding both kinds would pay twice for the same image. The flooring is done in integers and the remainder goes to the money side, so the parts always add back to exactly `C`.

### D5 — An image purchase is always finite
Validation refuses `unlimitedCredit` and `allowCustomAmount` with `kind = 'image'`. An unlimited *image* plan has no meaning as a product (an unbounded count for a fixed price) and would remove the only ceiling the charging loop relies on.

### D6 — Windows carry both units, and only one moves
`userPlanWindows` gains `spentImages` beside `spentNanoUsd`. `limitCeiling()` decides from the limit's own shape which unit it measures, so an image limit never blocks a dollar charge and a dollar limit never blocks an image charge. The migration is additive: existing windows keep `spentNanoUsd` and read `spentImages = 0`.

### D7 — A limit is serialised in the shape that was written
`normalizeLimits` omits `maxImages` when it is 0. A credit plan's stored JSON is therefore byte-identical to what earlier versions wrote, which matters because limits are snapshotted into `orders.limits` and `userPlans.limits` and compared in existing tests and in the `applyToActive` path.

### D8 — The customer sees two figures
`availableNanoUsd` and `availableImages` are computed separately and never summed, and both skip `scheduled` purchases for the same reason available credit already does: a purchase that has not started cannot pay.

## Risks / Trade-offs

- **A credit customer generating many images** can exhaust credit faster than expected because the per-image price is charged in full. Mitigated by the landing page stating the per-image price and by the plan card's window limits applying.
- **Doubling the queue pass.** `chargeSync` now walks the queue twice (images, then money). Measured cost is negligible — the queue is a handful of rows — and the alternative (a combined pass) makes the split rules much harder to read.
- **An image plan's per-image cost is invisible to the customer.** The combo's price is the owner's upstream cost, and the customer already bought a count. The admin form therefore shows the count, not the price.
- **`requestKind` must be threaded correctly.** A missed call site silently falls back to `llm`, which would make an image request unable to use an image plan (402) rather than overcharge. That direction is safe — fail closed, never free.

## Migration

Additive columns only, no backfill:

- `plans.kind` defaults to `'llm'`; `plans.imageCount` stays `NULL`.
- `orders.kind` defaults to `'llm'`; `orders.imageCount` stays `NULL`.
- `userPlans.kind` defaults to `'llm'`; `imageTotal`/`imageRemaining` default to 0.
- `userPlanWindows.spentImages` defaults to 0.
- `creditLedger.deltaImages` defaults to 0; `balanceAfterImages` stays `NULL` on pre-existing rows, which is correct — they have no image balance.

`SCHEMA_VERSION` 31 → 32 so `migrate.js` takes its pre-change backup. The additive auto-sync adds the columns; no row is rewritten.
