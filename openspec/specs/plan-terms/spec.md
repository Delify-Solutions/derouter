# plan-terms Specification

## Purpose
Lets a customer buy a plan for several periods at once (1, 3, 6, 12 months…) at a discount the admin sets per term, and makes sure a customer never holds two overlapping unlimited purchases of the same plan — whether the second one was bought, gifted or granted by an admin — and that gifts count toward the plan's monthly purchase limit.
## Requirements
### Requirement: Terms offered per plan
A plan SHALL carry `termOptions`: a list of up to 8 extra terms `{ periods, discountPercent }`, `periods` an integer from 2 to 36 (unique within the plan) and `discountPercent` an integer from 0 to 90. One period at the plan's own price is always sold and is not listed. `POST /api/plans` and `PATCH /api/plans/[id]` SHALL accept and return `termOptions` and reject an invalid list with HTTP 400 and a Vietnamese message; a plan with a custom-amount top-up SHALL NOT sell extra terms. The admin plan form SHALL edit the terms with one-click 3, 6 and 12 period presets and show each term's price.

#### Scenario: Go sold for 3 and 12 months
- **WHEN** an admin saves "Go" (30 days, 250.000đ / $10) with `termOptions = [{periods: 3, discountPercent: 5}, {periods: 12, discountPercent: 15}]`
- **THEN** the customer can buy 1, 3 or 12 months of "Go"

#### Scenario: Duplicate term refused
- **WHEN** an admin submits two terms with `periods = 3`
- **THEN** the API answers 400 and nothing is saved

### Requirement: Term pricing
A term of N periods with discount D SHALL cost `round(price × N × (100 − D) / 100)` in each currency the plan is sold in (nano-USD and đồng, integers, half rounded up). The same function SHALL price the order on the server and the preview on every card.

#### Scenario: 3 months at 5%
- **WHEN** a customer picks 3 months of a 250.000đ / $10 plan with a 5% discount
- **THEN** VietQR asks for 712.500đ and Binance for $28.50

### Requirement: Ordering a term
`POST /api/account/orders` SHALL accept an optional `periods` (default 1). A term the plan does not offer, or `periods > 1` together with a custom amount, SHALL be refused with HTTP 400. The order SHALL snapshot `periods` and `discountPercent`; its amount and pay amount are the term total, while `creditNanoUsd` and `durationDays` stay per period. Order lists and the order page SHALL show the term ("3 tháng").

#### Scenario: Term not sold
- **WHEN** a customer posts `periods = 6` for a plan that sells only 1 and 3 periods
- **THEN** the API answers 400 and no order is created

### Requirement: A term grants back-to-back periods
Approving an order for N periods SHALL grant N purchases with the order's id, each with the full per-period credit, the duration and the limits snapshot; period k SHALL start when period k−1 expires. A purchase whose `startsAt` is still ahead SHALL be `active` but SHALL NOT be admitted, charged (neither pass) or counted in available credit; the queue SHALL label it `scheduled` ("Chờ kích hoạt", with its start date on the card). Refunding the order SHALL close every period, started or not.

#### Scenario: 3 months of a $100-credit plan
- **WHEN** an order for 3 periods of a 30-day, $100-credit plan is paid on 1 Nov
- **THEN** three purchases exist: 1 Nov–1 Dec paying now, 1 Dec–31 Dec and 31 Dec–30 Jan scheduled, each with $100, and the customer's available credit is $100

#### Scenario: First month spent early
- **WHEN** the first period runs out of credit while the second has not started
- **THEN** further usage is refused for lack of credit (or becomes debt for a request already admitted) until the second period starts

### Requirement: Unlimited plans of the same plan never overlap
When an unlimited-credit purchase of plan P is granted — by an order, a gift code or an admin grant — while the customer holds an active, unexpired unlimited purchase of P, the new purchase SHALL start when the last such purchase expires, so two unlimited purchases of the same plan never run at the same time and its window limits are never doubled. A finite-credit plan, or an unlimited purchase of a different plan, SHALL start immediately as before.

#### Scenario: Gift while the plan is running
- **WHEN** a customer whose unlimited "Go" runs until 24 Nov redeems a gift code for "Go" on 2 Nov
- **THEN** the gifted "Go" starts on 24 Nov and the customer's 5-hour limit stays that of one "Go"

### Requirement: Gifts count toward the monthly purchase limit
A plan's `purchaseLimitPerMonth` SHALL count, in the current UTC calendar month, the customer's orders of the plan that are not cancelled or expired PLUS the purchases of the plan granted without an order (gift code, admin grant) that are not revoked or refunded. An order for several periods counts once.

#### Scenario: Gift uses the slot
- **WHEN** "Go" allows 1 purchase per month and the customer redeemed a "Go" gift code this month
- **THEN** the "Go" card says the monthly limit is reached and checkout is refused

#### Scenario: Revoked gift frees the slot
- **WHEN** the admin revokes that gifted purchase
- **THEN** the customer can buy "Go" again this month

### Requirement: Terms on the purchase and landing pages
The customer purchase card SHALL show a term picker when the plan sells more than one term; the headline price, the struck-through undiscounted price with the saving, the credit line ("mỗi tháng × 3") and every payment button SHALL follow the chosen term. The landing plan card SHALL list each extra term with its price and discount.

#### Scenario: Picking 12 months
- **WHEN** a customer picks "12 tháng −15%" on the "Go" card
- **THEN** the card shows 2.550.000đ, the full price 3.000.000đ struck through, and the VietQR button reads "Chuyển khoản VietQR · 2.550.000đ"
