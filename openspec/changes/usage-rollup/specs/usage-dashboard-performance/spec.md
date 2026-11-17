## ADDED Requirements

### Requirement: Summaries over long ranges read hourly rollups
The Users and Providers summaries SHALL answer the whole hours of a range from hourly rollups and only the partial edges and the not-yet-rolled tail from raw rows, and SHALL return exactly what a read of the raw rows alone returns, for any range (hour-aligned or not, open-ended, inside one hour, spanning the lag window).

#### Scenario: A 30-day range
- **WHEN** a 30-day summary is requested and the rollup has caught up
- **THEN** at most two small raw ranges are read besides the rollup, and the totals, per-minute peaks and last-use times equal the raw read

#### Scenario: Rollup not caught up
- **WHEN** the rollup has not reached the requested hours (first run, or after an invalidation)
- **THEN** those hours are read raw and the answer is unchanged

### Requirement: The rollup never outlives the rows it summarises
Deleting usage history SHALL invalidate the rollup from the oldest hour affected, so that the next read recomputes it from the raw rows; retention pruning SHALL drop rolled hours older than the cut-off; a raw API key SHALL never be written to a rollup table.

#### Scenario: A customer clears their request log
- **WHEN** a key holder deletes their usage history
- **THEN** admin summaries no longer include that history, before and after the rollup catches up

### Requirement: The Overview refines "last used" only where the page shows precision
The Overview SHALL refine a bucket's last-used time from the daily rollup's date to an exact timestamp only for the last 48 hours, so that no scan of older history is needed for it.

#### Scenario: A 30-day Overview
- **WHEN** the 30-day Overview is requested
- **THEN** buckets used in the last 48 hours show their exact last-use time and older buckets show the date, which is how the page renders any time beyond a day

### Requirement: A read never undercounts because history was deleted while it ran
A summary read that yields between slices SHALL answer from raw rows when rolled rows were invalidated during the read.

#### Scenario: A customer clears their log mid-read
- **WHEN** history is deleted between two slices of a rollup read
- **THEN** the summary is recomputed from the raw rows rather than returned with missing hours
