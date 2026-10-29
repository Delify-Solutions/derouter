## Purpose

Lets the admin price each plan separately for VietQR bank transfer (VND) and for Binance (USD, paid in USDT), and decides which payment methods a plan offers, so customers always see and pay an amount the admin chose rather than a converted one.

## ADDED Requirements

### Requirement: Two prices per plan
A plan SHALL carry `priceVnd` (integer đồng, 0 or empty = not sold by VietQR) and the existing USD price (integer nano-USD, 0 = not sold by Binance). `POST /api/plans` and `PATCH /api/plans/[id]` SHALL accept `priceVnd` as a non-negative integer and reject anything else with HTTP 400. The admin plan form SHALL show "Giá VND (VietQR)" and "Giá USD (Binance)" fields.

#### Scenario: Go priced in both currencies
- **WHEN** an admin saves plan "Go" with `priceVnd = 250000` and a USD price of $10
- **THEN** `GET /api/plans` returns both prices for "Go"

#### Scenario: Negative VND price refused
- **WHEN** an admin saves `priceVnd = -1`
- **THEN** the response is HTTP 400 and the plan is unchanged

### Requirement: Offered payment methods
A plan SHALL offer the method `vietqr` only when `priceVnd > 0` and at least one active VND receiving provider (`sepay`, `web2m` or `acb`) exists, and the method `binance` only when its USD price is greater than zero and at least one active `binance` provider exists. The method `manual` SHALL be offered only when the setting `allowManualOrders` is on (default on). The customer purchase cards and `GET /api/account/plans` SHALL list exactly the offered methods per plan.

#### Scenario: No Binance provider
- **WHEN** plan "Go" has both prices but no Binance provider is active
- **THEN** the Go card offers VietQR (and manual if allowed) but not Binance

### Requirement: Prices on public and customer pages
Landing plan cards and customer purchase cards SHALL show every price of an offered method, formatted as `250.000đ` for VND and `$10` for USD; a plan with no offered method SHALL show "Chưa mở bán".

#### Scenario: Both prices shown
- **WHEN** "Go" offers VietQR and Binance
- **THEN** its landing card shows "250.000đ" and "$10"

### Requirement: Revenue per currency
The per-plan statistics SHALL report revenue per currency: `revenueVnd` (sum of `payAmount` of paid orders paid in VND) and `revenueUsdNano` (sum of paid orders paid in USDT or approved manually, in nano-USD). Refunded orders SHALL be excluded. The admin plans page SHALL show both figures.

#### Scenario: Mixed currencies
- **WHEN** "Go" has one paid VietQR order of 250,000đ and one paid Binance order of 10 USDT
- **THEN** `revenueVnd` is 250000 and `revenueUsdNano` equals $10
