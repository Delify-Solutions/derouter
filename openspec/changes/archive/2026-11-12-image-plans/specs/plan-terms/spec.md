## MODIFIED Requirements

### Requirement: Ordering a term
`POST /api/account/orders` SHALL accept an optional `periods` (default 1). A term the plan does not offer, or `periods > 1` together with a custom amount, SHALL be refused with HTTP 400. The order SHALL snapshot `periods`, `discountPercent`, `kind` and (for an image plan) `imageCount`; its amount and pay amount are the term total, while `creditNanoUsd`, `imageCount` and `durationDays` stay per period. Order lists and the order page SHALL show the term ("3 tháng").

#### Scenario: Term not sold
- **WHEN** a customer posts `periods = 6` for a plan that sells only 1 and 3 periods
- **THEN** the API answers 400 and no order is created

#### Scenario: Image term is per period
- **WHEN** a customer buys 3 periods of an image plan that sells 100 images per 30 days
- **THEN** the order carries `periods = 3`, `imageCount = 100` and the 3-period price, and approval grants three back-to-back purchases of 100 images each

### Requirement: A term grants back-to-back periods
Approving an order for N periods SHALL grant N purchases with the order's id, each with the full per-period balance (`credit`, or `imageCount` for an image plan), the duration and the limits snapshot; period k SHALL start when period k−1 expires. A purchase whose `startsAt` is still ahead SHALL be `active` but SHALL NOT be admitted, charged (neither pass) or counted in available credit or available images; the queue SHALL label it `scheduled` ("Chờ kích hoạt", with its start date on the card). Refunding the order SHALL close every period, started or not.

#### Scenario: 3 months of a $100-credit plan
- **WHEN** an order for 3 periods of a 30-day, $100-credit plan is paid on 1 Nov
- **THEN** three purchases exist: 1 Nov–1 Dec paying now, 1 Dec–31 Dec and 31 Dec–30 Jan scheduled, each with $100, and the customer's available credit is $100

#### Scenario: First month spent early
- **WHEN** the first period runs out of credit while the second has not started
- **THEN** further usage is refused for lack of credit (or becomes debt for a request already admitted) until the second period starts

#### Scenario: 3 months of an image plan
- **WHEN** an order for 3 periods of a 30-day, 100-image plan is paid on 1 Nov
- **THEN** three purchases exist with 100 images each, only the first is admitted for image requests, and available images is 100
