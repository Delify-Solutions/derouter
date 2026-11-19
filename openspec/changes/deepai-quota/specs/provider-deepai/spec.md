## ADDED Requirements

### Requirement: DeepAI accounts show their Theos allowance, plan and free models on the quota page
For each DeepAI connection, `/dashboard/quota` SHALL show:
- the Theos allowance from `GET /deepai_code/theos`, as a bar of `balance` out of `granted` that resets at `refresh_at`. When no grant size is given, the balance SHALL be stated as text ("Còn N Theos"). When the allowance is disabled, a message SHALL be shown instead.
- the account's plan, DeepAI Pro or DeepAI Free, read live from `GET https://api.deepai.org/get_usage_summary`. The flag stored at sign-in SHALL be used when that call fails.
- which of the account's catalog models are free (`theosPerRequest` "0") and which spend Theos, with their price per request.

#### Scenario: Free account with part of its allowance used
- **WHEN** `/theos` answers `balance "250", granted "1000"` and `/get_usage_summary` answers `is_pro: false`
- **THEN** the card shows "Gói: DeepAI Free" and a Theos bar with 250 of 1000 left and its reset time

#### Scenario: Entitlement call fails
- **WHEN** `/get_usage_summary` fails for an account that signed in as Pro
- **THEN** the card still shows "Gói: DeepAI Pro"

### Requirement: An exhausted DeepAI model moves to another account
When DeepAI answers `theos_exhausted`, "Daily limit reached" or "Too many requests today", the router SHALL lock that model on that account for 30 minutes, the longest rate-limit cooldown the router allows. Requests SHALL then try other accounts, and the lock SHALL be visible on the Providers page. Any other 429 SHALL keep the normal short backoff.

#### Scenario: A free model's daily limit
- **WHEN** account A answers "Daily limit reached" for `glm-5.3-flash`
- **THEN** `glm-5.3-flash` is locked on A for 30 minutes, the request is retried on account B, and A's other models stay available

### Requirement: The DeepAI provider page lists the account's live catalog and can refresh it
The DeepAI provider page SHALL list the active account's live model catalog, falling back to the bundled list. Each model SHALL carry a Free, "N Theos/request" or Premium badge from the catalog. A "Tải model mới nhất" button SHALL re-read the catalog immediately, skipping the 5-minute cache.

#### Scenario: DeepAI adds a model
- **WHEN** the admin presses "Tải model mới nhất" right after DeepAI adds a model
- **THEN** the new model appears with its price badge without waiting for the cache to expire
