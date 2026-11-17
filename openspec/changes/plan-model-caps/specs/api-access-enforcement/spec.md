## ADDED Requirements

### Requirement: Cap denial is explicit
A request refused because of a model cap SHALL return 429 with code `model_cap` and a Vietnamese message naming the cap, stating the reopen time when there is one, and not suggesting that other models are unavailable.

#### Scenario: Whole-term cap used up
- **WHEN** a customer's only purchase has spent its whole-term cap for the requested model
- **THEN** the response is 429 `model_cap` without a Retry-After
