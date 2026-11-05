## ADDED Requirements

### Requirement: Discount reason shown to customers
The optional label of a discount rule SHALL be presented to the admin as the discount reason that customers see. Wherever a customer or visitor sees a discount ("Giảm X%") — the landing pricing table, the model pages, the public usage page's model table and the account usage history — the reasons of the rules that produced it SHALL be shown with it. A rule without a label adds no reason; a discount from several rules shows each distinct reason.

#### Scenario: Reason on the model page
- **WHEN** combo `gpt` has an active 20% rule labelled "Black Friday"
- **THEN** its row shows the discounted price, "Giảm 20%" and "Black Friday"

#### Scenario: Reason in the usage history
- **WHEN** a request was discounted by that rule
- **THEN** its row in the account usage history shows "giảm 20%" and "Black Friday"
