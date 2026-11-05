## ADDED Requirements

### Requirement: Token statistics page
The admin SHALL have a statistics page that, for a chosen time range (presets or a custom from/to, in Vietnam time), shows the number of requests and errors, input, output and cached tokens, the requests' price and the credit charged to customers, as totals, as a time series bucketed by hour, day, week (starting Monday) or month, and as a table broken down by requested model, upstream model, provider or customer. The view SHALL be filterable by customer, provider and model, and exportable as CSV. Requests refused by the platform (no tokens moved) SHALL be excluded. A customer SHALL be identified through the request's key, including a key deleted since.

#### Scenario: Per customer for last month
- **WHEN** the admin picks "Tháng trước", by day, broken down by customer
- **THEN** each customer's requests, tokens, price and charged credit for that month are listed, and the chart shows daily tokens for the top customers

#### Scenario: Range too fine
- **WHEN** the admin asks for hourly buckets over a year
- **THEN** the request is refused with a message to pick a larger unit or a shorter range

#### Scenario: Drill down
- **WHEN** the admin clicks a model in the table
- **THEN** the page is filtered to that model
