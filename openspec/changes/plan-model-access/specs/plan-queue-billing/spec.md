## MODIFIED Requirements

### Requirement: Admission
Before forwarding a request made with a customer key (after the access checks of `api-access-enforcement`), the system SHALL filter the queue by the request's kind (`image-plans` "The queue admits by kind"), then by the request's model, and then look for the first eligible plan.

A purchase SHALL be eligible for a request only when its own snapshot of `allowedModels` is `null` (no restriction) or matches the model the client asked for, using the same matching as the group allow-list (`modelMatching`), so a combo name, a provider-prefixed id and a dated id all collapse together.

The remaining conditions are unchanged: an eligible plan needs its own balance greater than zero (`imageRemaining` for `kind = 'image'`, `creditRemainingNanoUsd` for `kind = 'llm'`), a `startsAt` not later than now, an expiry later than now, and it must not be window-blocked.
- If such a plan exists, the request SHALL proceed on it.
- Otherwise, if at least one plan that **allows this model** is funded and unexpired and only window-blocked, the system SHALL respond HTTP 429 with error code `plan_limit`, a `Retry-After` header equal to the whole seconds (rounded up) until the earliest reopen time among those plans, `resetAt` set to that time in ISO-8601 UTC inside the error object, and a Vietnamese message stating the relative wait (for example "Các gói đang chạm hạn mức, mở lại sau 1 giờ 12 phút").
- Otherwise the system SHALL respond HTTP 402 with error code `insufficient_quota` and the message "Hết quota — mua gói hoặc nhập mã quà tặng tại /account/plans".

A purchase that does not allow the requested model SHALL be treated as **not applicable to this request**, never as blocked: it SHALL NOT contribute a 429 reopen time, so a customer whose quota on an ineligible plan is full is not told to wait for a window that would not help.

Admin keys and keyless local requests SHALL bypass admission.

#### Scenario: First plan blocked, second eligible
- **WHEN** plan 1 is window-blocked and plan 2 has credit
- **THEN** the request proceeds

#### Scenario: Every plan blocked
- **WHEN** plan 1 reopens at 15:30, plan 2 reopens at 14:10 and it is 13:00
- **THEN** the response is HTTP 429 `plan_limit` with `Retry-After: 4200` and `resetAt` equal to 14:10

#### Scenario: Nothing left
- **WHEN** the user has no queued plan with credit
- **THEN** the response is HTTP 402 `insufficient_quota`

#### Scenario: Image purchase cannot pay a text request
- **WHEN** the user's only funded plan is an image purchase and the request is a chat completion
- **THEN** the response is HTTP 402 `insufficient_quota`

#### Scenario: The plan that allows the model pays, not the first in queue
- **WHEN** the user holds plan A (allows only `claude-sonnet`, $100 left, first in queue) and plan B (allows only `gpt-5`, $10 left), and requests `gpt-5`
- **THEN** the request proceeds on plan B

#### Scenario: Model no live plan allows
- **WHEN** the user's only funded plan allows `claude-sonnet` and the request asks for `gpt-5`
- **THEN** the response is HTTP 402 `insufficient_quota`

#### Scenario: An ineligible plan is not a reason to wait
- **WHEN** the user's `gpt-5` plan is window-blocked, and a `claude-sonnet` plan with credit exists but does not allow `gpt-5`, and the request asks for `gpt-5`
- **THEN** the response is HTTP 429 naming the `gpt-5` plan's reopen time, not 402

### Requirement: Charging a completed request
Each amount taken SHALL produce one ledger row on the purchase that paid it, carrying the request key, the model the client asked for, and the balance after the charge, and SHALL advance that purchase's window counters by the same amount, all inside one transaction.

The queue SHALL be re-evaluated at charge time, and the same model filter as admission SHALL apply: a purchase that does not allow the requested model SHALL NOT pay for the request, at either pass. A shortfall that can only be covered by a purchase which does not allow the model SHALL become debt, exactly as a shortfall with no funded plan does, rather than being charged to the wrong purchase.

#### Scenario: Charged to the plan that allowed the model
- **WHEN** a `gpt-5` request is admitted on plan B and by charge time plan A (first in queue) has been refilled
- **THEN** the ledger row names plan B, and plan A's credit is unchanged

#### Scenario: No eligible plan left at charge time
- **WHEN** the only purchase that allowed the requested model expired between admission and charge
- **THEN** the cost becomes overdraft debt and no other purchase is charged
