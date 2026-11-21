## MODIFIED Requirements

### Requirement: Usage by customer
The admin usage page SHALL have a "Users" tab (`/dashboard/usage?tab=users`; the old `?tab=keys` opens it). It groups usage by the customer who owns the key, because one customer may hold many keys.

**Period:** today, 24 hours, 7, 30 or 60 days. The default is 30 days. An invalid period bound SHALL be answered with HTTP 400.

**Customer row:** each customer SHALL be one row with:
- e-mail, linked to their user detail page;
- display name and group;
- active and total key count;
- requests;
- input, output and input-cache tokens, marked `≈` when part of the figure is estimated;
- cost;
- peak requests and peak tokens in one minute, summed over all of their keys;
- the time of their last request.

**Opening a row** SHALL show:
- each of their keys: name, masked key (only the prefix and the last four characters), status, requests, tokens, cost, last request;
- each model they called, by the model name the client asked for.

**Special rows:**
- Customers who own keys but made no request in the period SHALL be listed with zero figures. A "With requests" filter SHALL hide them.
- Keys with no owner SHALL be grouped as one "Admin keys" row. Requests made without any key (local traffic) appear in it as a "No key (local)" line.
- Usage whose key no longer exists SHALL be one "Deleted or unknown keys" row.

**Order and toolbar:**
- Rows SHALL be sorted by cost, highest first, by default.
- The shared table toolbar (spec admin-usage-views "Shared table toolbar") SHALL let the admin:
  - re-sort by requests, tokens, cost or last request, in either direction;
  - cut the list to the Top 10, 20 or 50;
  - search by e-mail, name, group, key name or masked key.

**Data source:** the data SHALL come from the admin-only `GET /api/usage/user-summary`, which SHALL NOT return any key secret or request payload.

#### Scenario: One customer, two keys
- **WHEN** a customer made 3 requests with their laptop key and 2 with their server key in the period
- **THEN** the Users tab shows one row for that customer with 5 requests and the summed tokens and cost, and opening it lists both keys with 3 and 2 requests

#### Scenario: Idle customer
- **WHEN** a customer owns a key but made no request in the period
- **THEN** they are listed with 0 requests and "—" as last request, and disappear when "With requests" is selected

#### Scenario: Re-sorted by requests
- **WHEN** the admin chooses "Sắp xếp theo: Requests", "Nhiều → ít" on the Users tab
- **THEN** the customer with the most requests in the period is first, and the default cost order returns when the sort parameters are removed from the URL
