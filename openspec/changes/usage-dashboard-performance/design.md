## Measurements (seeded SQLite, same machine)

| | old | new |
|---|---|---|
| 300 k rows: Users 30 d | 1.2 s, server blocked 1.2 s | 0.7 s, longest stall 19 ms |
| 300 k rows: Providers 30 d | 1.1 s, blocked 1.1 s | 0.8 s, longest stall 85 ms |
| 1.5 M rows: Users 30 d | 16.0 s, blocked 16.0 s | 6.9 s, longest stall 94 ms |
| 1.5 M rows: Providers 30 d | 16.4 s, blocked 16.4 s | 5.5 s, longest stall 275 ms |
| 1.5 M rows: Overview 30 d | 12.2 s, blocked 12.2 s | 6.3 s, longest stall 67 ms |
| SSE push per completed request | 12.6 s (full recompute) | 1 ms |
| Repeat load within the cache window | same as cold | 0 ms |

Row scan cost (~0.7–1.5 µs/row) dominates, in JS and in SQLite alike: pushing the per-row JSON parsing into SQLite only helped the Overview path, so the Users and Providers summaries keep their per-row JS logic and are sliced rather than rewritten. A rewrite of those two in SQL was built, proved equal, and dropped: no faster, more code to keep equal.

## Decisions

- **D1 slices of 3 h.** Indexed range reads on `timestamp`; a slice is ≈10 ms at 300 k rows/30 d. Order is preserved (oldest first) so `ORDER BY timestamp ASC` consumers see the same sequence. Per-minute peak maps accumulate across slices, so a minute straddling a slice boundary is still one bucket.
- **D2 GROUP BY per slice is merged by the caller.** The overlay keeps the newest timestamp per bucket; the 24 h path adds counts; both are associative.
- **D3 cache keys include every input.** `stats:<period>`, `chart:<period>`, `owner:<start minute>:<end minute>` (the page sends "now", so raw dates never repeat), `provider:<period>`. TTLs 15–45 s; a value is served stale for 20× its TTL while it refreshes.
- **D4 known cosmetic ties.** The keyless bucket's `rawModel`/`provider` names whichever row was scanned first (unchanged semantics, order now differs); `provider` is `null` vs `""` for rows without one; models equal in cost and requests are now ordered by name.
