## ADDED Requirements

### Requirement: A full model cap refuses that model only
Admission SHALL treat a purchase whose matching model cap is full as unable to pay for the requested model, while it stays able to pay for every other model. Spend on a capped model SHALL still reduce the purchase's credit and count in its window limits. When no purchase can pay and at least one is blocked only by a model cap, the request SHALL be refused with HTTP 429 `model_cap` naming the cap; `resetAt` SHALL be present only when the cap is windowed.

#### Scenario: Images used up, text continues
- **GIVEN** a $150 purchase with a whole-term image cap of $15 and $15 already spent on images
- **WHEN** the customer requests an image model
- **THEN** the request is refused with 429 `model_cap` and no reopen time
- **AND** a DeepSeek request is still admitted and paid from the remaining credit

#### Scenario: Another purchase can pay
- **GIVEN** the capped purchase is full for images and a second purchase has image room
- **WHEN** the customer requests an image model
- **THEN** the second purchase pays

### Requirement: Caps bind charging like windows do
Charging SHALL take from a purchase no more than the room left in every cap matching the request's model in pass 1. Pass 2 SHALL ignore caps and record the spend. Spend per (purchase, cap) SHALL be rebuildable from charge ledger rows, which SHALL record the model.

#### Scenario: Request larger than the room left
- **GIVEN** $0.50 of room in the image cap and an image request costing $0.80
- **WHEN** it is charged and no other purchase has room
- **THEN** the purchase pays the whole $0.80 and the cap reads full for the next request
