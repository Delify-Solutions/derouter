## MODIFIED Requirements

### Requirement: Plan queue page
`/account/plans` ("Gói của tôi") SHALL show, in queue order, each queued plan with: name, source label (`Mua`, `Tặng`, `Admin`, `Hoàn tiền`), its balance with a progress bar, expiry date and days left, every limit in the plan's own unit, and one status label: `Đang trả` (the plan admission would pick now), `Chờ`, or `Tạm khóa đến <HH:MM>`. The balance SHALL be remaining and total credit for a credit plan (an unlimited-credit plan showing "Không giới hạn" instead of a bar), and remaining and total images, labelled "ảnh", for an image plan. Each limit SHALL read "<window label>: $<spent> / $<max> · reset <HH:MM>" for a credit plan and "<window label>: <spent> / <max> ảnh · reset <HH:MM>" for an image plan, or the same without the reset time when the window is closed.

A purchase that restricts models SHALL name the models it covers, and its status label SHALL reflect that: `Đang trả` only when admission would actually pick it for some model, `Chờ` otherwise. A purchase that restricts models and is window-blocked reads `Tạm khóa đến <HH:MM>` exactly as an unrestricted one does.

Above the queue the page SHALL show available credit and, when the customer holds at least one live image purchase, available images as a separate figure — the two SHALL never be added together.

#### Scenario: Restricted plan card
- **WHEN** a customer holds a purchase whose plan allows only `claude-sonnet` and `gpt-5`
- **THEN** the card names those two models and still shows its credit, expiry and limits as before

#### Scenario: Two plans, two model sets
- **WHEN** a customer holds plan A (allows `claude-sonnet`) and plan B (allows `gpt-5`)
- **THEN** the page shows both cards with their own model names, and neither reads as covering the other's models
