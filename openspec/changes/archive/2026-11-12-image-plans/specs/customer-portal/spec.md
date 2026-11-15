## MODIFIED Requirements

### Requirement: Plan queue page
`/account/plans` ("Gói của tôi") SHALL show, in queue order, each queued plan with: name, source label (`Mua`, `Tặng`, `Admin`, `Hoàn tiền`), its balance with a progress bar, expiry date and days left, every limit in the plan's own unit, and one status label: `Đang trả` (the plan admission would pick now), `Chờ`, or `Tạm khóa đến <HH:MM>`. The balance SHALL be remaining and total credit for a credit plan (an unlimited-credit plan showing "Không giới hạn" instead of a bar), and remaining and total images, labelled "ảnh", for an image plan. Each limit SHALL read "<window label>: $<spent> / $<max> · reset <HH:MM>" for a credit plan and "<window label>: <spent> / <max> ảnh · reset <HH:MM>" for an image plan, or "<window label>: chưa dùng" when no window is open. Times SHALL be shown in the browser's local time.

Above the queue the page SHALL show available credit and, when the customer holds at least one live image purchase, available images as a separate figure — the two SHALL never be added together.

The plans SHALL be split into two tabs, `Đang hoạt động` (the queue above) and `Không hoạt động`, each showing its count. The inactive tab SHALL list every purchase that is not `active`, newest first, with its plan name, source, start and expiry, the balance received in the plan's own unit and a status label: `Hết credit` (exhausted), `Hết hạn` (expired), `Đã hủy` (revoked) or `Đã hoàn tiền` (refunded). A plan SHALL appear on exactly one tab. The tabs SHALL follow the WAI-ARIA tabs pattern (arrow keys move between them).

#### Scenario: Refunded plan leaves the queue
- **WHEN** an admin refunds an order whose plan was in the queue
- **THEN** the plan is absent from `Đang hoạt động` and appears on `Không hoạt động` as "Đã hoàn tiền"

#### Scenario: Statuses for a blocked first plan
- **WHEN** plan 1 is window-blocked until 15:30 and plan 2 is eligible
- **THEN** plan 1 shows "Tạm khóa đến 15:30" and plan 2 shows "Đang trả"

#### Scenario: Image plan card
- **WHEN** a customer holds an image purchase with 40 of 100 images left and a 5-hour limit of 20 images with 12 spent
- **THEN** its card shows "40 / 100 ảnh" with a progress bar and "5 giờ: 12 / 20 ảnh · reset 15:00"

### Requirement: Buying from the page
The page SHALL show a card per active plan with price, the plan's balance line, "Dùng <N> ngày", each limit, and whether it can be bought (with the existing blocking reason when not). The balance line SHALL be "Nhận $<credit> dùng chung mọi model" for a credit plan and "Nhận <N> ảnh" for an image plan, and an image plan SHALL NOT offer a custom-amount top-up. Buying SHALL create a pending order through the existing manual flow and show "Đơn đã tạo — chuyển khoản theo hướng dẫn, admin duyệt xong gói sẽ vào hàng đợi". With `?plan=<code>` in the URL, that plan's card SHALL be highlighted and scrolled into view. The page SHALL also list the customer's orders and, collapsed by default, past plans (exhausted, expired, revoked).

#### Scenario: Deep link to a plan
- **WHEN** the customer opens `/account/plans?plan=go`
- **THEN** the "Go" card is highlighted and in view

#### Scenario: Image plan buy card
- **WHEN** an active image plan sells 100 images for 30 days
- **THEN** its card shows "Nhận 100 ảnh", "Dùng 30 ngày" and no amount field
