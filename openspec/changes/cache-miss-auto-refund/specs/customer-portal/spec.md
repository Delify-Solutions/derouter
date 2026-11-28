## MODIFIED Requirements

### Requirement: Navigation and language
The account navigation SHALL be, in order: `Tổng quan` (/account), `Gói của tôi` (/account/plans), `Nhật ký credit` (/account/ledger), `Mã quà tặng` (/account/gift), `API key` (/account/keys), `Lịch sử dùng` (/account/usage), `Hoàn tiền cache` (/account/cache-refunds). Every account page SHALL be in Vietnamese.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

## ADDED Requirements

### Requirement: Usage history cache-miss indicator
`/account/usage` SHALL mark, on a row whose request was flagged by `cache-miss-refund`, that the request did not get its expected cache discount, next to its existing cache-token columns, without naming any internal cause.

#### Scenario: Flagged row marked
- **WHEN** a customer's request was flagged as a cache miss
- **THEN** its row on `/account/usage` shows the indicator, with no internal-cause wording

### Requirement: Cache-miss refunds page
`/account/cache-refunds` SHALL list the customer's own cache-miss refunds, newest first: date, amount, and the generic reason "Hệ thống không dùng được cache cho yêu cầu này" (identical wording for every row, regardless of the internal cause). It SHALL follow the same loading/error/empty states and accessibility conventions as the rest of the account pages (spec "Interface states and accessibility").

#### Scenario: Customer's refund list
- **WHEN** a customer has received two auto-refunds
- **THEN** `/account/cache-refunds` lists both, newest first, each with the same generic reason text

#### Scenario: No refunds yet
- **WHEN** a customer has no cache-miss refunds
- **THEN** the page shows its empty state
