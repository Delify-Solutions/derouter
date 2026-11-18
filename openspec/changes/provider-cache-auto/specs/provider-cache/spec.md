## ADDED Requirements

### Requirement: Cache auto adds breakpoints only when the request has none
For a provider whose Cache setting is Auto, a request sent to a Claude-format upstream SHALL be forwarded unchanged when it already carries a `cache_control` marker anywhere in `system`, `tools` or `messages`. When it carries none, the router SHALL add cache breakpoints (last system block and last tool at 1h, the conversation tail at 5m), at most 4, never on a thinking block. With the default setting caching behaviour SHALL be exactly as before.

#### Scenario: A CLI that sends no cache hint
- **GIVEN** provider Cache is Auto and a CLI sends a string system prompt, plain tools and string messages
- **THEN** the upstream request carries breakpoints on the system prompt, the last tool and the conversation tail

#### Scenario: A CLI that already caches
- **GIVEN** provider Cache is Auto and the request has a `cache_control` on any block
- **THEN** the upstream request is identical to what the client sent (apart from the router's other, unrelated shaping)

#### Scenario: Default
- **GIVEN** provider Cache is the default
- **THEN** no breakpoint is added by this feature
