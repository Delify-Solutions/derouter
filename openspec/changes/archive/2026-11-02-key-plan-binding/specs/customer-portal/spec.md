## MODIFIED Requirements

### Requirement: API key page
`/account/keys` SHALL list the customer's keys (name, first 8 characters followed by `…`, creation date, status, and the plan the key is pinned to or "Tất cả gói") and SHALL let the customer create a key with a name of 1–80 characters and an "Áp dụng cho" choice (all plans, or one plan the customer currently holds, showing its RPM/TPM), change that choice afterwards ("Đổi gói"), and delete a key after confirmation. The form SHALL explain that RPM/TPM follow the plan and are shared by every key of that plan. A key whose pinned plan has no live purchase SHALL show a "Gói hết hạn" status. The API SHALL refuse (400) a plan the customer does not currently hold and SHALL treat another customer's key as not found. After creation the full secret SHALL be shown exactly once with a copy control and the warning "Lưu key ngay — bạn sẽ không xem lại được". The page SHALL show the API base URL (`<public base URL>/v1`, the public base URL being the `publicBaseUrl` setting or the request origin) with a copy control. With no keys it SHALL show "Bạn chưa có API key" and a "Tạo key" action.

#### Scenario: Secret shown once
- **WHEN** a customer creates a key and reloads the page
- **THEN** the list shows only the 8-character prefix and no way to reveal the secret

#### Scenario: Creating a key for one plan
- **WHEN** a customer holding plans A and B creates a key choosing plan B
- **THEN** the key is listed with plan B and its requests are paid from B only

#### Scenario: Plan not held
- **WHEN** a customer submits a plan id they do not currently hold, or one that belongs to another customer
- **THEN** the response is HTTP 400 and the key is not created or changed

#### Scenario: Moving a key
- **WHEN** a customer changes a key from plan B to "Tất cả gói"
- **THEN** the key's next request may be paid by the head of the queue
