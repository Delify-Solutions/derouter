## ADDED Requirements

### Requirement: The live usage stream never aggregates
The usage live stream SHALL push only in-memory state (in-flight requests, recent requests, last failing provider, pending counters) and SHALL NOT read `usageHistory`.

#### Scenario: A request completes while a tab is open
- **WHEN** a request completes and the stream emits an update
- **THEN** the payload is built from memory without a database scan

### Requirement: Summaries do not hold the server for the length of a scan
The Overview, Users and Providers summaries SHALL read a time range in bounded slices and yield to the event loop between slices, and SHALL return exactly the result of reading the range in one pass.

#### Scenario: A month of history
- **WHEN** a 30-day summary runs over millions of rows
- **THEN** no single uninterrupted stretch of work exceeds one slice, and the totals, per-minute peaks and last-used times equal the single-pass values

### Requirement: Repeated reads share one computation
The usage summary endpoints SHALL serve a cached result within its freshness window, SHALL serve an aged result immediately while exactly one refresh runs, SHALL keep serving the aged result if that refresh fails, and SHALL share one in-flight computation between concurrent callers. Live fields (in-flight requests, current per-minute rate) SHALL NOT be served from the cache.

#### Scenario: Several tabs
- **WHEN** ten tabs request the same summary at once
- **THEN** one aggregation runs and all receive its result
