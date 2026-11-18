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
