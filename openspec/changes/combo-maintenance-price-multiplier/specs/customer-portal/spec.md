## ADDED Requirements

### Requirement: Maintenance label on model price tables
Every customer-facing model price table (the public usage page and the account models page) SHALL show the label "Bảo trì" next to a combo that is under maintenance, as text (not colour alone), and SHALL keep showing its price.

#### Scenario: Label shown
- **WHEN** combo `gpt` is under maintenance and a customer opens the account models page
- **THEN** the row for `gpt` shows "Bảo trì" and its price

#### Scenario: Label removed
- **WHEN** maintenance is turned off
- **THEN** the row shows no label
