## ADDED Requirements

### Requirement: Two kinds of plan
A plan SHALL have a `kind` of `llm` (the default, including every plan stored before this change) or `image`. An `llm` plan sells credit spent at token prices. An `image` plan sells a whole number of generated images, spent one image per image returned, and SHALL NOT carry credit: creating or updating a plan to `kind = 'image'` SHALL store `creditNanoUsd = 0`, `unlimitedCredit = false` and `allowCustomAmount = false` regardless of what the request sent, and switching a plan back to `llm` SHALL store `imageCount = 0`. The two balances SHALL never convert into each other in either direction.

#### Scenario: Image plan ignores credit in the same request
- **WHEN** an admin creates code `img100`, `kind = "image"`, `imageCount = 100` and `creditNanoUsd = $999`
- **THEN** the plan is stored with `imageCount = 100`, `creditNanoUsd = 0` and `kind = "image"`

#### Scenario: Existing plans stay credit plans
- **WHEN** the instance is upgraded with plans created before this change
- **THEN** each of them is read as `kind = "llm"` with `imageCount = 0` and behaves exactly as before

#### Scenario: Switching kinds clears the other unit
- **WHEN** an admin edits a credit plan to `kind = "image"` with `imageCount = 20`, then edits it back to `kind = "llm"` with $50 credit
- **THEN** the plan ends as `kind = "llm"`, `creditNanoUsd = $50` and `imageCount = 0`

### Requirement: An image plan is a fixed count for a fixed term
An `image` plan SHALL have `imageCount` — an integer greater than zero — and `durationDays` (integer ≥ 1). A non-positive or fractional `imageCount` SHALL be rejected with HTTP 400 and a Vietnamese message naming the count; `unlimitedCredit` SHALL be rejected with a message saying an image plan does not sell unlimited credit; `allowCustomAmount` SHALL be rejected with a message saying an image plan does not take a custom amount. An `llm` plan SHALL continue to require credit greater than zero or `unlimitedCredit`.

#### Scenario: Fractional count refused
- **WHEN** an admin saves an image plan with `imageCount = 2.5`
- **THEN** the response is HTTP 400 naming the image count and nothing is saved

#### Scenario: Unlimited image plan refused
- **WHEN** an admin saves an image plan with `unlimitedCredit = true`
- **THEN** the response is HTTP 400 with a message saying an image plan sells a fixed number of images

### Requirement: An image purchase holds images and no credit
Approving an order, redeeming a plan gift code and an admin "grant plan" on an `image` plan SHALL each create one purchased plan with `kind = 'image'`, `imageTotal` = the purchased count, `imageRemaining` = the same count, `creditTotalNanoUsd = 0` and `creditRemainingNanoUsd = 0`, alongside the source, start, expiry, status and limits snapshot of any other grant. The order SHALL snapshot `kind` and `imageCount` at creation, and approval SHALL grant that snapshot even if the template changed or was deleted in between.

#### Scenario: Order snapshot survives an edit
- **WHEN** a customer orders "100 ảnh", the admin then changes that plan to 50 images and approves the order
- **THEN** the granted purchase carries 100 images

#### Scenario: Gift of an image plan
- **WHEN** a user redeems a gift code for an image plan of 100 images
- **THEN** the new purchase holds 100 images, 0 credit and the plan's limits snapshot

### Requirement: The queue admits by kind
For a request made with a customer key the queue SHALL be filtered by the request's kind before admission:
- a token request (chat, embeddings, any non-image endpoint) SHALL consider only purchases with `kind = 'llm'`;
- an image request (`POST /v1/images/generations`) SHALL consider purchases with `kind = 'image'` first, in the normal queue order, then purchases with `kind = 'llm'`.

A purchase SHALL be eligible when its own balance is greater than zero (`imageRemaining` for an image purchase, `creditRemainingNanoUsd` for a credit purchase), its expiry is later than now and it is not window-blocked. The 429 and 402 responses SHALL keep the wording and fields of `plan-queue-billing` "Admission".

#### Scenario: Image plan cannot pay for text
- **WHEN** a user holds only an image purchase with 10 images left and sends a chat request
- **THEN** the response is HTTP 402 `insufficient_quota`

#### Scenario: Credit pays for an image when no image purchase can
- **WHEN** a user holds a credit purchase and a fully spent image purchase and sends an image request
- **THEN** the request is admitted on the credit purchase

#### Scenario: Image purchase wins over an earlier credit purchase
- **WHEN** a user's queue is a credit purchase then an image purchase and an image request arrives
- **THEN** the request is admitted on the image purchase

### Requirement: An image is charged in the unit the paying plan sells
Charging SHALL follow the paying purchase's kind:
- paid by an `image` purchase, a completed image request SHALL subtract one image per returned image from `imageRemaining` and record one ledger row of kind `charge` with `deltaImages = -(images)` and `deltaNanoUsd = 0`; the combo's per-image price SHALL NOT be charged to the customer, so no debt and no overdraft can arise from it;
- paid by an `llm` purchase, an image request SHALL be charged the per-image price times the number of images, exactly as `plan-queue-billing` "Image generation is priced per image" already requires.

A purchase whose `imageRemaining` reaches zero SHALL become `exhausted`. Charging SHALL remain idempotent per request key: a repeated charge SHALL write no ledger row and SHALL NOT change `imageRemaining`. A run of image requests SHALL be split across purchases in queue order, taking from each purchase as many images as it has left, and SHALL write one ledger row per purchase.

#### Scenario: Two images from an image plan
- **WHEN** an image plan with 5 images left generates 2 images
- **THEN** `imageRemaining` becomes 3, one `charge` row records `-2` images and 0 nano-USD, and no debt is recorded

#### Scenario: Split across two image purchases
- **WHEN** purchases hold 1 and 4 images and a request returns 3 images
- **THEN** the first purchase is exhausted, the second holds 2, and two `charge` rows record `-1` and `-2` images

#### Scenario: Retried image charge
- **WHEN** the same image request key is charged twice
- **THEN** exactly one ledger row exists and `imageRemaining` dropped once

### Requirement: Closing an image purchase takes its images back
Expiry, revoke and refund of an `image` purchase SHALL set `imageRemaining` to 0, delete its window state and record one ledger row of kind `expire`, `revoke` or `adjust` with `deltaImages` equal to the negative number forfeited and `deltaNanoUsd = 0`. Images already spent SHALL stay spent and SHALL NOT be refunded as credit.

#### Scenario: Expiring image purchase
- **WHEN** an image purchase with 12 images left expires
- **THEN** it becomes `expired`, holds 0 images, and one `expire` row records `-12` images and 0 nano-USD

#### Scenario: Revoking an image purchase
- **WHEN** an admin revokes an image purchase with 9 images left
- **THEN** the purchase holds 0 images, its status is `revoked`, and the audit entry carries the reason

### Requirement: Image balances are reported separately
The customer's plan payload SHALL expose `kind`, `imageTotal` and `imageRemaining` per purchase, and the account overview SHALL expose `availableImages` — the sum of `imageRemaining` over active, unexpired image purchases — next to the existing `availableNanoUsd`. The two sums SHALL be computed independently, so a customer holding both kinds sees two figures that never blend.

#### Scenario: Both kinds held
- **WHEN** a customer holds a credit purchase with $20 left and an image purchase with 40 images left
- **THEN** the overview reports $20 available credit and 40 available images

#### Scenario: Exhausted image purchase not counted
- **WHEN** the only image purchase has 0 images left
- **THEN** `availableImages` is 0 and the purchase is not in the active queue

### Requirement: Rates follow the purchase that pays the request
The RPM, TPM and concurrency cap applied to a customer request SHALL be those of the purchase admission picks for that request's kind, so an image request admitted on an image purchase is rated by the image plan, and a text request is never rated by an image plan. The account's displayed rate SHALL be the one a text request would get, since that is the page's subject.

#### Scenario: Image request rated by the image plan
- **WHEN** an image plan sets 5 RPM and a text plan sets 100 RPM, and the customer sends image requests
- **THEN** the 5 RPM allowance applies and a sixth request in the minute is answered 429 `rate_limit`

#### Scenario: Text request ignores the image plan's rate
- **WHEN** the same customer sends a chat request admitted on the text plan
- **THEN** the text plan's 100 RPM applies, not the image plan's 5

### Requirement: Every surface reads an image purchase in images
Wherever a purchase's balance, movement or limit is shown — the queue card, the inactive-plan tab, the account overview, the ledger (customer and admin), the admin purchase history, the admin limits and revoke dialogs, and the plan history — an image purchase SHALL be shown in images: its balance as "<remaining> / <total> ảnh", a movement as a signed count ("+100 ảnh", "−2 ảnh") with no dollar figure, a limit as "<spent> / <max> ảnh", and an exhausted image purchase as "Hết ảnh" rather than "Hết credit". A credit purchase SHALL keep its existing dollar wording, and no surface SHALL show "$0.00" to mean "images moved".

#### Scenario: Image grant in the ledger
- **WHEN** a customer receives an image purchase of 100 images
- **THEN** the ledger row reads "Được cấp ảnh", "+100 ảnh" and "100 ảnh", not "$0.00"

#### Scenario: Image charge in the ledger
- **WHEN** an image request generates 2 images on an image purchase
- **THEN** its ledger row reads "Trừ ảnh", "−2 ảnh" and the new balance

#### Scenario: Admin edits an image purchase's limits
- **WHEN** an admin opens "Sửa hạn mức" on an image purchase with a 5-hour ceiling of 20 images
- **THEN** the dialog reads "20 ảnh mỗi 5 giờ", labels the field "Tối đa (ảnh)" and pre-fills 20

#### Scenario: Exhausted image purchase in history
- **WHEN** an image purchase runs out of images
- **THEN** the inactive tab shows it as "Hết ảnh" with its total and remaining images
