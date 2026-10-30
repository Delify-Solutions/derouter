# payment-provider-admin Specification

## Purpose
Gives the admin one place to configure the accounts that receive money (SePay, web2m, Binance), keep their credentials safe, test them without side effects, and watch every payment that arrives.
## Requirements
### Requirement: Provider configuration
`/dashboard/payments` (tab "Nguồn nhận tiền") SHALL list, create, edit, enable/disable and delete providers. Fields by kind:
- `sepay`: name, bank (VietQR BIN and display name), account number, account holder, webhook key (generated on creation, regenerable), optional API token for polling, poll interval;
- `web2m`: name, bank (BIN and display name), account number, account holder, web2m API base URL, URL style (`token` or `password/account/token`), token, bank password (only for the second style), poll interval;
- `acb`: name, account number, account holder, ACB internet-banking username, password, optional HTTP proxy URL, optional overrides of the app identity (client id, app api key, device id, app version — defaults come from the environment variables `ACB_CLIENT_ID`, `ACB_API_KEY`, `ACB_DEVICE_ID`, `ACB_APP_VERSION`), poll interval (minimum 30 seconds for this kind);
- `binance`: name, Binance Pay UID, account name, optional QR image URL, API key, API secret, poll interval.

The `acb` form SHALL show the warning "Dùng API app ACB không chính thức — ACB có thể thay đổi hoặc khóa truy cập; nên dùng tài khoản riêng cho việc nhận tiền."

Secrets (webhook key, API token, web2m token and password, ACB password and its cached token, proxy credentials, Binance API key and secret) SHALL be encrypted at rest with the existing secret encryption and SHALL never be returned by the API after saving — the API returns only whether each is set and its last 4 characters. A provider with orders or transactions SHALL NOT be deletable (HTTP 409); it can be disabled. Provider order (sort) decides which provider a new order uses.

#### Scenario: Secret not echoed
- **WHEN** the admin saves a Binance provider and reloads the page
- **THEN** the API secret field shows only "đã lưu (…a1b2)" and the full value is not in any API response

### Requirement: SePay webhook setup aid
For a `sepay` provider the page SHALL show the webhook URL (`<public base URL>/api/payments/sepay/webhook`) and the webhook key with copy controls, and the instruction to choose "API Key" authentication in SePay.

#### Scenario: Copy webhook settings
- **WHEN** the admin opens a SePay provider
- **THEN** the webhook URL and key are shown with copy buttons

### Requirement: Dry run
"Chạy thử" on a provider SHALL fetch its recent transactions (for `sepay`, through the API token; unavailable without one) and return, for each incoming transaction, what reconciliation would decide (`matched` with the order, or `needs_review` with the reason, or `duplicate`) without storing anything or changing any order.

#### Scenario: Dry run changes nothing
- **WHEN** the admin runs "Chạy thử" while a matching payment is in the bank history
- **THEN** the result says the order would be matched and the order is still `pending` afterwards

### Requirement: Transactions list
Tab "Giao dịch" SHALL list stored transactions newest first, 50 per page, with time, provider, amount and currency, content, status (`Đã khớp`, `Cần kiểm tra`, `Đã xử lý`), reason, linked order and customer email; SHALL filter by status, provider and date range; SHALL show the raw payload in a drawer; and SHALL offer the resolution actions of spec `payment-reconciliation` on `needs_review` rows. A badge in the admin navigation SHALL show the number of `needs_review` transactions.

#### Scenario: Filter transactions needing review
- **WHEN** the admin filters by "Cần kiểm tra"
- **THEN** only `needs_review` transactions are listed and each shows its reason

### Requirement: Payment settings
The admin settings SHALL include `paymentCodePrefix` (2–6 uppercase letters, default `DR`), `paymentOrderTtlMinutes` (10–1440, default 30) and `allowManualOrders` (default on), validated with HTTP 400 on invalid values.

#### Scenario: Invalid prefix
- **WHEN** the admin saves the prefix `dr-1`
- **THEN** the response is HTTP 400 and the prefix is unchanged

