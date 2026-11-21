# admin-usage-views Specification

## Purpose
Lets the operator read the admin usage tabs by the model customers called (the combo they bought) or by the upstream model that answered, and search, filter, sort and cut every usage table the same way.
## Requirements
### Requirement: Model view switch
Usage → Overview and Usage → Details SHALL each show a labelled two-option control "Model: Khách gọi | Gốc".
- **Default:** "Khách gọi" (requested).
- **URL:** the choice is kept in the query parameter `modelView` (`requested` or `upstream`). Any other or missing value means `requested`. Reloading or sharing the URL keeps the choice.
- **Requested view:** the model shown for a request is the model name the client sent (for a combo, the combo name). A request with no recorded requested model is shown under its upstream model.
- **Upstream view:** the model shown is the upstream model that served the request, exactly as before this change.
- **Billing:**
  - The switch SHALL NOT change any charge, price or recorded cost.
  - A customer is still charged the combo price when the combo has one, otherwise the price of the upstream model that answered.
  - Every cost figure in either view is the sum of the costs already recorded for the requests it covers.

#### Scenario: Combo shown by its own name
- **WHEN** a customer called combo `glm-5` 3 times, answered twice by `zai/glm-5.3:pre` and once by `openrouter/glm-5`, and the admin opens the Overview with `modelView=requested`
- **THEN** the Model table shows one row `glm-5` with 3 requests and the sum of the three recorded costs, and no row for either upstream model

#### Scenario: Upstream view unchanged
- **WHEN** the same admin switches to "Gốc"
- **THEN** the URL holds `modelView=upstream` and the Model table shows `glm-5.3:pre` with 2 requests and `glm-5` (openrouter) with 1, with the same figures the page showed before this change

#### Scenario: Missing requested model
- **WHEN** a recorded request has no requested model and was served by `gpt-4o`
- **THEN** the requested view counts it under `gpt-4o`

#### Scenario: Invalid parameter
- **WHEN** the URL holds `modelView=foo`
- **THEN** the page shows the requested view and the switch reads "Khách gọi"

#### Scenario: Charges unaffected
- **WHEN** a request is recorded while either view is open
- **THEN** its recorded cost and the customer's charge equal what they would have been without this change

### Requirement: Overview tables by requested model
With the requested view, the Overview tables SHALL group as follows:
- **Model:** by requested model. Its provider cell lists the providers that served it, in descending request order, at most 3 names followed by "+N".
- **Account:** by (requested model, upstream account).
- **Key:** by (key, requested model).
- **Endpoint:** by (endpoint, requested model).

Totals, the provider breakdown, the 10-minute activity and the recent-requests list SHALL be identical in both views. This SHALL hold for every period the Overview offers (today, 24 h, 7, 30, 60 days).

#### Scenario: Same totals in both views
- **WHEN** the admin compares the 30-day Overview in "Khách gọi" and "Gốc"
- **THEN** total requests, tokens and cost are identical, and the Model table rows of each view sum to those totals

#### Scenario: Key table by requested model
- **WHEN** one key called combo `glm-5` 4 times and `claude-sonnet` 2 times today
- **THEN** the requested-view Key table shows that key with a `glm-5` row of 4 requests and a `claude-sonnet` row of 2

### Requirement: Requested-model history and its limit
Requested-model daily figures SHALL be recorded for every request from this change on. For each earlier day whose raw requests are all still kept (inside the raw-history retention, `LOG_RETENTION_DAYS`, default 60), they SHALL be rebuilt from those raw requests.
- **Background build:** the rebuild runs in the background without blocking request handling or the dashboard for more than one short slice at a time.
- **Idempotent:** a day already built is not counted again, whether the rebuild is interrupted, restarted or run twice.
- **Concurrent requests:** a request recorded while its day is being rebuilt is counted exactly once.
- **Days without requested data:** a day whose raw requests are partly or wholly gone SHALL use its upstream-model figures in the requested view. This covers rows removed by retention, and rows deleted or missing for any other reason (a customer clearing their history, imported history, a time-zone change), detected because the raw requests no longer add up to the day's recorded totals. Such a day SHALL never be reported as having requested figures.
- **Days completed before a deletion:** when raw requests of a day whose requested figures were already recorded are deleted later, both views keep counting them, as the day's totals do; the two views stay consistent.
- **Note:** when the chosen period contains such a day, the Overview SHALL show the note "Trước ngày <first day with requested data> chỉ có model gốc" when those days are exactly the days before that date; otherwise it SHALL name them, oldest first: "Ngày <day>, <day> chỉ có model gốc", listing at most the five most recent such days and adding "và <N> ngày trước đó" for the N older ones (for example "Ngày 18/11/2026, 20/11/2026 và 2 ngày trước đó chỉ có model gốc").
- **Rebuild in progress:** while the rebuild has not finished, the Overview SHALL show "Đang tính lại số liệu theo model khách gọi…".

#### Scenario: Backfill does not double count
- **WHEN** the rebuild for a day runs, is interrupted, and runs again
- **THEN** that day's requested-view figures equal the sum of its raw requests, once

#### Scenario: Request during rebuild
- **WHEN** a request for today is recorded while today is being rebuilt
- **THEN** today's requested-view request count includes it exactly once

#### Scenario: Day older than retention
- **WHEN** the 60-day Overview includes a day whose raw rows were pruned
- **THEN** that day's requests appear under their upstream model names and the page shows "Trước ngày <date> chỉ có model gốc"

#### Scenario: History cleared before the rebuild
- **WHEN** a day recorded before this change had 4 requests, a customer cleared 2 of them, and the rebuild then runs
- **THEN** that day is not given requested figures: the requested view shows its 4 requests under their upstream model names, the Model rows still add up to the totals, and the page names the day in its note

#### Scenario: Model names that look like object members
- **WHEN** clients ask for models named `__proto__`, `constructor`, `toString` or `valueOf`
- **THEN** each is counted as its own row in the requested view, exactly like any other name, and no other figure changes

### Requirement: Request details by model
Usage → Details SHALL do the following:
- **Model column:** show the requested or upstream model per the switch. The detail panel always shows both, labelled "Model khách gọi" and "Model gốc".
- **Model filter:** offer a "Model" filter listing the distinct models of the current view present in the stored request details.
- **Sort:** offer sorting by time, total tokens (input + output) or total latency, each "Nhiều → ít" or "Ít → nhiều". The default is time, newest first. Ties are broken by time, newest first. A request with no token or latency figure sorts after every request that has one, in both directions.
- **Pagination:** sorting and filtering apply before pagination, across all stored request details.
- **API:** `GET /api/usage/request-details` SHALL accept the following, and SHALL reject an invalid `sort` or `order` with HTTP 400:
  - `modelView`;
  - `q`, the toolbar search, matched case-insensitively (full Unicode, e.g. "đức" finds "Nguyễn Văn Đức") against the requested and upstream model, the provider and the key owner's e-mail, display name and key name;
  - `model` (matched against the model of the given view);
  - `sort` (`time`, `tokens` or `latency`);
  - `order` (`desc` or `asc`).
- **Stored rows:** request details stored before this change SHALL be filterable by requested model.

#### Scenario: Filter by combo
- **WHEN** the admin selects model `glm-5` in the requested view
- **THEN** only requests whose client asked for `glm-5` are listed, whichever upstream served them, and pagination counts only those

#### Scenario: Heaviest requests first
- **WHEN** the admin sorts by tokens, "Nhiều → ít"
- **THEN** the first row is the stored request with the most input + output tokens, and requests without token figures are last

#### Scenario: Bad sort value
- **WHEN** a client calls `GET /api/usage/request-details?sort=price`
- **THEN** the API answers HTTP 400 and lists nothing

### Requirement: Shared table toolbar
The Users, Overview (Model, Account, Key and Endpoint tables), Details and Providers tables SHALL each show the same toolbar.
- **Search:** a text field "Tìm kiếm". It matches case-insensitively, with full Unicode case folding (Vietnamese capitals included), against the table's name columns: model, provider, account, key name, masked key, endpoint, e-mail, display name, group.
- **Filters:** "Model", "Provider" and "Người dùng", each shown only where the table has that column. A filter lists the distinct values present in the table's current data, plus "Tất cả".
- **Sort, "Sắp xếp theo":**
  - fields: Requests, Tokens (input + output), Chi phí and Lần dùng cuối; Details uses Thời gian, Tokens and Độ trễ instead;
  - direction "Nhiều → ít" or "Ít → nhiều".
- **Rows:** "Hiển thị" with Top 10, Top 20, Top 50 and Tất cả.
- **Defaults:**
  - Users: Chi phí, Nhiều → ít, Tất cả;
  - Overview tables: Requests, Nhiều → ít, Tất cả;
  - Providers: Requests, Nhiều → ít, Tất cả;
  - Details: Thời gian, Nhiều → ít, paginated.
- **Sort order rules:** rows that compare equal are ordered by their name ascending. A row with no value for the sort field (never used, no last request) sorts after every row that has one, in both directions.
- **URL state:** the toolbar state is kept in the URL query, so reloading or sharing the URL restores it. The parameters are namespaced per table, so two tables on one page do not override each other.
- **Column headers:** clicking a sortable column header sets the same sort field and direction the toolbar shows, and vice versa.
- **Totals:** a table's totals cover the whole period whatever the search, filters or Top N ("Tổng kỳ"); when those hide rows, the totals of the rows shown are added on their own, labelled ("Tổng đang hiển thị").
- **Accessibility and style:**
  - every control has a visible label and is operable by keyboard alone;
  - the active sort is announced by its column header (`aria-sort`) as well as the toolbar;
  - the toolbar follows `openspec/ui-dna.md`.

#### Scenario: Keys used least
- **WHEN** the admin opens the Overview Key table and chooses "Sắp xếp theo: Requests" and "Ít → nhiều"
- **THEN** the key with the fewest requests is first, and the URL holds that choice so a reload shows the same order

#### Scenario: Top 10 by cost
- **WHEN** the admin picks "Chi phí", "Nhiều → ít" and "Top 10" on the Users tab, which has 40 customers
- **THEN** exactly the 10 customers with the highest cost are shown, highest first, and the counter reads "10 / 40"

#### Scenario: Never-used rows stay last
- **WHEN** the Users tab is sorted by "Lần dùng cuối", "Ít → nhiều", and some customers made no request in the period
- **THEN** those customers are listed after every customer with a last request

#### Scenario: Header click syncs the toolbar
- **WHEN** the admin clicks the "Cost" header of the Providers table
- **THEN** the toolbar shows "Chi phí" and "Nhiều → ít", and clicking the header again switches both to "Ít → nhiều"

### Requirement: Table states
Every table with the shared toolbar SHALL show:
- a loading state while its data is fetched;
- on a failed fetch, the message "Không tải được dữ liệu" with a "Thử lại" button that fetches again;
- when the data is non-empty but nothing matches the search and filters, "Không có dữ liệu khớp bộ lọc" with a "Xoá bộ lọc" button that resets search and filters (not the sort or the model view);
- when there is no data for the period, the table's existing empty message.

#### Scenario: Retry after failure
- **WHEN** the Providers summary request fails
- **THEN** the table shows "Không tải được dữ liệu" and "Thử lại", and pressing "Thử lại" requests the data again

#### Scenario: Clear filters
- **WHEN** a search matches no row
- **THEN** the table shows "Không có dữ liệu khớp bộ lọc", and "Xoá bộ lọc" empties the search and filters, restores the rows and keeps the chosen sort

