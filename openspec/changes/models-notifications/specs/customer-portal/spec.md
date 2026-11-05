## MODIFIED Requirements

### Requirement: Navigation and language
The account navigation SHALL be, in order: `Tổng quan` (/account), `Chat` (/account/chat), `Model` (/account/models), `Gói của tôi` (/account/plans), `Nhật ký credit` (/account/ledger), `Mã quà tặng` (/account/gift), `Giới thiệu` (/account/affiliate, only when the affiliate program makes it available), `API key` (/account/keys), `Lịch sử dùng` (/account/usage), `Thông báo` (/account/notifications, with the unread count), `Tài khoản` (/account/settings), then `Kênh Telegram` (the admin's channel, in a new tab) when one is set. Every account page SHALL be in Vietnamese.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

#### Scenario: Unread count in the menu
- **WHEN** the customer has 3 unread notifications
- **THEN** the "Thông báo" item shows 3, also in the mobile menu

## ADDED Requirements

### Requirement: Model pages
`/models` SHALL be public and list every model a visitor could buy access to, with list price, discounted price, reason and end of any discount. `/account/models` ("Model") SHALL list only the models the customer's group allows, with the customer's own discounts (their group and the plan that pays first), the model kind and a button that copies the model name. A customer without a live group SHALL see that no model can be called yet instead of the catalogue. The landing "Model" navigation item SHALL lead to `/models`.

#### Scenario: Group allow-list
- **WHEN** a customer whose group allows only `gpt` opens `/account/models`
- **THEN** only `gpt` is listed

### Requirement: Notifications page
`/account/notifications` ("Thông báo") SHALL have a "Thông báo chung" tab with the admin's announcements, newest first, important ones marked, and a "Của bạn" tab with the notifications the system sent this customer (payment, plan expiry, security), whether or not Telegram is linked. It SHALL also show a "Telegram" section with a button to join the Telegram channel when one is configured, and the Telegram link and per-type Telegram settings. The menu item SHALL show the number of unread items; opening the page SHALL mark the items it showed as read. Routine sign-in alerts SHALL NOT be stored there (they are in the account history).

The admin SHALL create, edit and delete announcements (title, body, important flag) on `/dashboard/announcements`, and MAY send a new announcement through the Telegram broadcast at the same time.

#### Scenario: Customer without Telegram
- **WHEN** an order of a customer without Telegram is approved
- **THEN** "Của bạn" lists the payment notice

#### Scenario: Unread badge
- **WHEN** the admin publishes an announcement
- **THEN** the customer's "Thông báo" item shows 1 until the customer opens the page

### Requirement: Telegram channel link
The admin SHALL set a Telegram channel link (`https://t.me/...`). When set, "Kênh Telegram" SHALL appear in the landing navigation and footer and in the customer menu, opening the channel in a new tab. An invalid link SHALL be refused.

#### Scenario: Channel configured
- **WHEN** the admin saves `https://t.me/derouter_news`
- **THEN** the landing navigation shows "Kênh Telegram" linking there
