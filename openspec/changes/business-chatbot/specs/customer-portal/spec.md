## MODIFIED Requirements

### Requirement: Buying from the page
The page SHALL group the active plans under two headings, "Gói API" and "Gói AI doanh nghiệp". A heading without plans SHALL be omitted.

Each plan card SHALL show:
- the price;
- "Nhận $<credit> dùng chung mọi model";
- "Dùng <N> ngày";
- each limit;
- for business plans, "Tối đa <maxBots> bot" and "Dung lượng tài liệu <size>";
- whether the plan can be bought, with the existing blocking reason when it cannot.

Buying SHALL create a pending order through the existing manual flow and show "Đơn đã tạo — chuyển khoản theo hướng dẫn, admin duyệt xong gói sẽ vào hàng đợi".

With `?plan=<code>` in the URL, that plan's card SHALL be highlighted and scrolled into view.

The page SHALL also list:
- the customer's orders;
- past plans (exhausted, expired, revoked), collapsed by default.

#### Scenario: Deep link to a plan
- **WHEN** the customer opens `/account/plans?plan=go`
- **THEN** the "Go" card is highlighted and in view

#### Scenario: Grouped by product line
- **WHEN** plans "go" (api) and "biz-start" (business) are active
- **THEN** "go" is listed under "Gói API" and "biz-start" under "Gói AI doanh nghiệp"

### Requirement: Navigation and language
The account navigation SHALL be, in order:

| Label | Path |
|---|---|
| `Tổng quan` | /account |
| `Chat` | /account/chat |
| `Gói của tôi` | /account/plans |
| `Nhật ký credit` | /account/ledger |
| `Mã quà tặng` | /account/gift |
| `API key` | /account/keys |
| `AI doanh nghiệp` | /account/business |
| `Lịch sử dùng` | /account/usage |

Every account page SHALL be in Vietnamese.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

#### Scenario: Business entry
- **WHEN** a signed-in customer opens the account navigation
- **THEN** "AI doanh nghiệp" appears between "API key" and "Lịch sử dùng"
