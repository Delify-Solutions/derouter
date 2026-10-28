## Purpose

Defines the signed-in customer's self-service area: creating and revoking API keys, seeing and reordering purchased plans with live window status, buying plans, and auditing every charge — entirely in Vietnamese and usable by keyboard.

## ADDED Requirements

### Requirement: API key page
`/account/keys` SHALL list the customer's keys (name, first 8 characters followed by `…`, creation date, status) and SHALL let the customer create a key with a name of 1–80 characters and delete a key after confirmation. After creation the full secret SHALL be shown exactly once with a copy control and the warning "Lưu key ngay — bạn sẽ không xem lại được". The page SHALL show the API base URL (`<public base URL>/v1`, the public base URL being the `publicBaseUrl` setting or the request origin) with a copy control. With no keys it SHALL show "Bạn chưa có API key" and a "Tạo key" action.

#### Scenario: Secret shown once
- **WHEN** a customer creates a key and reloads the page
- **THEN** the list shows only the 8-character prefix and no way to reveal the secret

### Requirement: Plan queue page
`/account/plans` ("Gói của tôi") SHALL show, in queue order, each queued plan with: name, source label (`Mua`, `Tặng`, `Admin`, `Hoàn tiền`), remaining and total credit with a progress bar, expiry date and days left, every limit as "<window label>: $<spent> / $<max> · reset <HH:MM>" or "<window label>: chưa dùng" when no window is open, and one status label: `Đang trả` (the plan admission would pick now), `Chờ`, or `Tạm khoá đến <HH:MM>`. Times SHALL be shown in the browser's local time.

#### Scenario: Statuses for a blocked first plan
- **WHEN** plan 1 is window-blocked until 15:30 and plan 2 is eligible
- **THEN** plan 1 shows "Tạm khoá đến 15:30" and plan 2 shows "Đang trả"

### Requirement: Reordering from the page
The customer SHALL be able to move plans with a drag handle or with "↑"/"↓" buttons. Any unsaved change SHALL reveal "Lưu thứ tự" and "Huỷ". Saving SHALL submit the full order; on success a one-line confirmation SHALL appear; on HTTP 409 the page SHALL show "Danh sách gói đã thay đổi — đã tải lại" and reload the queue; "Huỷ" SHALL restore the saved order.

#### Scenario: Save new order
- **WHEN** the customer moves plan 2 above plan 1 and presses "Lưu thứ tự"
- **THEN** the next API request is charged to plan 2

### Requirement: Buying from the page
The page SHALL show a card per active plan with price, "Nhận $<credit> dùng chung mọi model", "Dùng <N> ngày", each limit, and whether it can be bought (with the existing blocking reason when not). Buying SHALL create a pending order through the existing manual flow and show "Đơn đã tạo — chuyển khoản theo hướng dẫn, admin duyệt xong gói sẽ vào hàng đợi". With `?plan=<code>` in the URL, that plan's card SHALL be highlighted and scrolled into view. The page SHALL also list the customer's orders and, collapsed by default, past plans (exhausted, expired, revoked).

#### Scenario: Deep link to a plan
- **WHEN** the customer opens `/account/plans?plan=go`
- **THEN** the "Go" card is highlighted and in view

### Requirement: Ledger page
`/account/ledger` SHALL list the customer's ledger newest first, 25 rows per page: time, kind label (`Trừ tiền`, `Cấp`, `Hết hạn`, `Điều chỉnh`, `Hoàn tiền`, `Thu hồi`), plan name, model and input/output tokens for charges, signed amount, and balance after. It SHALL filter by plan and by kind.

#### Scenario: Charge row shows the model
- **WHEN** a request to `model-x` with 1,200 input and 300 output tokens is charged $0.004
- **THEN** the ledger shows a `Trừ tiền` row with `model-x`, 1,200 / 300 tokens and -$0.004

### Requirement: Overview page
`/account` SHALL show: a "Gói đang trả" card (plan name, remaining credit, nearest window reset) or an empty state offering "Mua gói" and "Nhập mã quà tặng"; total available credit; the debt amount when debt exists; and the group name with the number of callable models and an expandable list of them.

#### Scenario: No plan
- **WHEN** a new customer with no plans opens `/account`
- **THEN** the "Gói đang trả" card shows the empty state with both actions

### Requirement: Navigation and language
The account navigation SHALL be, in order: `Tổng quan` (/account), `Gói của tôi` (/account/plans), `Sổ cái` (/account/ledger), `Mã quà tặng` (/account/gift), `API key` (/account/keys), `Lịch sử dùng` (/account/usage). Every account page SHALL be in Vietnamese.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

### Requirement: Interface states and accessibility
Every data region SHALL have a static skeleton while loading, an empty state of one sentence plus one action, an error state that names what failed with a "Thử lại" action, and disabled controls while saving. Long names SHALL be truncated with the full text available on hover and focus; tables SHALL scroll horizontally on narrow screens. Reordering SHALL be fully keyboard operable: "↑"/"↓" buttons labelled "Đưa gói <name> lên" / "Đưa gói <name> xuống", a polite live region announcing the new position, and keyboard support for dragging. Progress bars SHALL expose progressbar semantics with a label. Status SHALL never rely on color alone. Styling SHALL follow `openspec/ui-dna.md`.

#### Scenario: Keyboard reorder
- **WHEN** a keyboard user focuses "Đưa gói Go#2 lên" and presses Enter
- **THEN** Go#2 moves up one place and the live region announces its new position

### Requirement: Customer plan and ledger API
`GET /api/account/plans` SHALL return the available credit, the debt, the queue (each plan with id, name, code, source, total and remaining credit, start, expiry, priority, status label and reopen time, and per limit its hours, maximum, spent, open time and reset time), the history, and the purchasable plans with their blocking reason. `PUT /api/account/plans/order` SHALL accept `{ orderedIds }` and answer 200 with the new queue, 400 for an invalid body, or 409 `queue_changed`. `GET /api/account/ledger` SHALL accept `page`, `planId` and `kind` and return `{ entries, total, page, pageSize }`. All three SHALL require the customer session and SHALL only ever return the caller's own data.

#### Scenario: Another user's plan id
- **WHEN** a customer submits an order list containing another user's plan id
- **THEN** the response is HTTP 409 `queue_changed` and nothing changes
