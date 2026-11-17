## ADDED Requirements

### Requirement: A plan may cap the spend of a group of models
A plan SHALL accept an optional list of model caps, each `{ id, label, models, maxNanoUsd, hours }`. `models` is a non-empty list of existing combo names, `maxNanoUsd` a positive integer below the plan's credit (any positive integer for an unlimited-credit plan), and `hours` either null (the whole life of a purchase) or an integer from 1 to the plan's duration in hours. A plan holds at most 5 caps, with unique ids and non-empty labels of at most 40 characters. Caps SHALL be refused on image-count plans. A missing id SHALL be generated.

#### Scenario: Image cap inside a credit pool
- **WHEN** an admin saves a $150 plan with the cap `{ label: "Ảnh", models: ["gpt-image"], maxNanoUsd: 15e9, hours: null }`
- **THEN** the plan stores it and every purchase of the plan is held to $15 of image spend in total

#### Scenario: Unknown model
- **WHEN** a cap names a combo that does not exist
- **THEN** the save is refused naming the model

#### Scenario: Cap not below the credit
- **WHEN** a cap's maximum is not below the plan's credit
- **THEN** the save is refused, because such a cap could never bind
