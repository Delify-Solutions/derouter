## ADDED Requirements

### Requirement: A provider's Thinking setting is Auto, a forced level, or Off
The admin SHALL be able to set each provider's Thinking to Auto, to one of the levels the provider's models support, or to Off. With Auto the request's own thinking instruction SHALL be forwarded as the client sent it. With a level the router SHALL use that level for every request to the provider, replacing whatever thinking instruction the client sent (including a `model(level)` suffix). With Off the router SHALL switch thinking off.

#### Scenario: Auto keeps the client's choice
- **GIVEN** provider Thinking is Auto and a client sends a 12000-token thinking budget
- **THEN** the upstream request carries that budget

#### Scenario: A level wins over the client
- **GIVEN** provider Thinking is Max and a client asks for low (in any request shape)
- **THEN** the upstream request carries Max in the provider's native field and none of the client's thinking fields

#### Scenario: Off
- **GIVEN** provider Thinking is Off and a client asks for high
- **THEN** the upstream request has thinking disabled, or the provider's lowest allowed level where it cannot be disabled

### Requirement: A level the provider's model does not accept is mapped, not sent as is
When a provider publishes the thinking levels each model accepts (Command Code's catalog), the router SHALL send only a listed level: a requested or forced level that is not listed moves to the nearest listed one, and Off is sent as the provider's own "off" value when the model lists it, or as the model's lowest listed level when it cannot switch thinking off. This applies in Auto too, because a value the model does not accept would be refused.

#### Scenario: Command Code deepseek-v4.1-flash
- **WHEN** a request asks for medium, or for no thinking, on a model that lists off/low/high/max
- **THEN** the upstream receives low, or "off"

### Requirement: Command Code's effort lists come from its live catalog
The router SHALL take the efforts each Command Code model accepts from Command Code's public model catalog, read in the background at most every `refreshAfterSeconds` (bounded to 1 minute – 24 hours) and never blocking a request, and SHALL fall back to a bundled snapshot of that catalog when the live one is not available or does not list the model. A model whose catalog entry has no effort list SHALL never receive `reasoning_effort`, even when a level is forced or the client sends one.

#### Scenario: A model added by Command Code
- **WHEN** the live catalog lists a model the snapshot does not know
- **THEN** its efforts are used from the next background refresh on, without a code change

#### Scenario: A model without effort setting
- **WHEN** a level is forced for `moonshotai/Kimi-K2.6` (catalog efforts: none)
- **THEN** the upstream request carries no `reasoning_effort`
