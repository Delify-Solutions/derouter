## MODIFIED Requirements

### Requirement: Request details by model
Usage → Details SHALL do the following:
- **Model column:** show the requested or upstream model per the switch. The detail panel always shows both, labelled "Model khách gọi" and "Model gốc".
- **Model filter:** offer a "Model" filter listing the distinct models of the current view present in the stored request details.
- **Account column:** show the name (or e-mail, if no name) of the provider connection that served the request, taken from the request's recorded connection. A request with no recorded connection (e.g. it predates connection tracking) SHALL show "—".
- **Profit column:** show the request's profit, computed as its recorded charge minus its recorded vendor cost (see `vendor-cost-pricing`). A request with no recorded vendor cost (see that capability's "Historical requests have no vendor cost" requirement) SHALL show "Chưa có dữ liệu giá vốn" instead of a number, and SHALL NOT be treated as zero cost or zero profit by any total.
- **Sort:** offer sorting by time, total tokens (input + output) or total latency, each "Nhiều → ít" or "Ít → nhiều". The default is time, newest first. Ties are broken by time, newest first. A request with no token or latency figure sorts after every request that has one, in both directions.
- **Pagination:** sorting and filtering apply before pagination, across all stored request details.
- **API:** `GET /api/usage/request-details` SHALL accept the following, and SHALL reject an invalid `sort` or `order` with HTTP 400:
  - `modelView`;
  - `q`, the toolbar search, matched case-insensitively (full Unicode, e.g. "đức" finds "Nguyễn Văn Đức") against the requested and upstream model, the provider and the key owner's e-mail, display name and key name;
  - `model` (matched against the model of the given view);
  - `sort` (`time`, `tokens` or `latency`);
  - `order` (`desc` or `asc`).
- **Stored rows:** request details stored before this change SHALL be filterable by requested model.

#### Scenario: Filter by combo
- **WHEN** the admin selects model `glm-5` in the requested view
- **THEN** only requests whose client asked for `glm-5` are listed, whichever upstream served them, and pagination counts only those

#### Scenario: Heaviest requests first
- **WHEN** the admin sorts by tokens, "Nhiều → ít"
- **THEN** the first row is the stored request with the most input + output tokens, and requests without token figures are last

#### Scenario: Bad sort value
- **WHEN** a client calls `GET /api/usage/request-details?sort=price`
- **THEN** the API answers HTTP 400 and lists nothing

#### Scenario: Account shown per request
- **WHEN** a request was served by the provider connection named "Claude - acc2"
- **THEN** its Details row shows "Claude - acc2" in the Account column

#### Scenario: Profit shown for a priced request
- **WHEN** a request charged the customer 500,000 nano-USD and its recorded vendor cost is 300,000 nano-USD
- **THEN** its Details row shows a profit of 200,000 nano-USD

#### Scenario: Profit missing for a request without vendor cost
- **WHEN** a request has no recorded vendor cost
- **THEN** its Details row shows "Chưa có dữ liệu giá vốn" and is excluded from any profit total shown elsewhere on the page, rather than counted as 0

## ADDED Requirements

### Requirement: Overview profit and loss summary
Usage → Overview SHALL show, for the chosen period, a summary of total revenue (sum of recorded charges), total vendor cost (sum of recorded vendor costs, counting only requests that have one) and net profit (revenue minus that vendor cost), alongside the existing totals.
- When every request in the period has a recorded vendor cost, the summary SHALL be shown as plain figures.
- When some or all requests in the period have no recorded vendor cost, the summary SHALL add the note "Một số yêu cầu chưa có dữ liệu giá vốn" (or, when none at all have one, "Chưa có dữ liệu giá vốn cho kỳ này" and no vendor cost or profit figure is shown).
- The Model, Account, Key and Endpoint tables SHALL each gain a profit column, computed the same way per row (sum of that row's requests' charges minus the sum of that row's requests' vendor costs, counting only requests that have one), with the same missing-data note when a row has no priced requests.
- This summary and column SHALL NOT change, and SHALL be computed without touching, any charge, price or recorded cost used for customer billing.

#### Scenario: Full period priced
- **WHEN** every request in the chosen period has a recorded vendor cost
- **THEN** the Overview shows total revenue, total vendor cost and net profit as plain figures

#### Scenario: Partially priced period
- **WHEN** the chosen period includes requests recorded before vendor cost pricing existed
- **THEN** the Overview shows revenue, vendor cost (summed only over priced requests) and profit, together with "Một số yêu cầu chưa có dữ liệu giá vốn"

#### Scenario: Nothing priced yet
- **WHEN** no request in the chosen period has a recorded vendor cost
- **THEN** the Overview shows "Chưa có dữ liệu giá vốn cho kỳ này" and no vendor cost or profit figure

### Requirement: Users vendor-cost column
Usage → Users SHALL show a column "Đã dùng thực (giá vốn)": the sum of the recorded vendor cost of that customer's requests in the chosen period, counting only requests that have one.
- A customer with no priced requests in the period SHALL show "—" in this column, not 0.
- This column SHALL be sortable like any other column the shared toolbar offers for this table, and SHALL NOT change any figure used for that customer's billing.

#### Scenario: Customer with priced usage
- **WHEN** a customer made 10 requests in the period, 6 of them with a recorded vendor cost totalling 1,200,000 nano-USD
- **THEN** their Users row shows 1,200,000 nano-USD in "Đã dùng thực (giá vốn)"

#### Scenario: Customer with no priced usage
- **WHEN** none of a customer's requests in the period have a recorded vendor cost
- **THEN** their Users row shows "—" in that column

### Requirement: Provider cache ratio and per-connection breakdown
Usage → Providers SHALL show, per provider row, a cache-hit-ratio column: the share of that provider's total input tokens in the period that were cache reads or cache-creation writes, as a percentage. A provider with no input tokens in the period SHALL show "—".

Each provider row SHALL be expandable to a breakdown by individual provider connection (account): for each connection that served at least one request in the period, its requests, tokens, cost, cache-hit ratio and (per the profit requirements above) vendor cost and profit, labelled by the connection's name (or e-mail, if no name).

#### Scenario: Provider cache ratio
- **WHEN** a provider served 1,000,000 input tokens in the period, 250,000 of them cache reads or cache-creation writes
- **THEN** its Providers row shows a 25% cache-hit ratio

#### Scenario: Expand to per-account breakdown
- **WHEN** the admin expands a provider row that was served by two connections, "Claude - acc1" and "Claude - acc2"
- **THEN** the breakdown lists both, each with its own requests, tokens, cost and cache-hit ratio for the period, and their totals equal the provider row's totals
