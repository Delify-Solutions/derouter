## ADDED Requirements

### Requirement: Purchases are scoped to the key's product line
Every queue walk for a customer key SHALL consider only the purchases of that key's product line. This applies to admission, the paying plan used for RPM and TPM, and charging.
- A key with a `botId` belongs to the `business` line. It SHALL see only purchases whose plan has `productLine = business`.
- Every other customer key belongs to the `api` line. It SHALL see:
  - purchases whose plan has `productLine = api`;
  - credit-only grants with no plan, such as gift credit and admin adjustments.

Key pinning (`apiKeys.planId`) SHALL keep narrowing the queue further, within the line.

A customer whose only credit sits in the other line SHALL get the line-specific "nothing left" response:
- **`business` line:** HTTP 402 `insufficient_quota` with the message "Hết quota gói AI doanh nghiệp — mua gói tại /doanh-nghiep".
- **`api` line:** the existing message.

A charge SHALL never take credit from a purchase of the other line. A shortfall SHALL become debt as today.

#### Scenario: Bot key with only an API plan
- **WHEN** a customer holds only an `api` purchase with credit and calls a business model with a bot key
- **THEN** the response is 402 "Hết quota gói AI doanh nghiệp — mua gói tại /doanh-nghiep"

#### Scenario: API key does not drain the business plan
- **WHEN** a customer holds an exhausted `api` purchase and a business purchase with credit, and calls a normal model with a normal key
- **THEN** the response is 402 `insufficient_quota`, and the business purchase is unchanged

#### Scenario: Gift credit stays on the API line
- **WHEN** a customer's only credit is a credit-only gift grant and they call with a bot key
- **THEN** the request is refused with the business 402 message
