## ADDED Requirements

### Requirement: Manage Telegram links
The admin SHALL see, on the user detail page, whether the account is linked to Telegram (username, Telegram id, link time), and on `/dashboard/telegram` a searchable list of every linked account (email, @username or Telegram id) with whether the bot can reach it. From both places the admin SHALL be able to remove a link with a reason of 3–500 characters.

Removing a link SHALL clear it, SHALL tell the Telegram user beforehand when possible (a failed message never blocks the removal), SHALL be audited on the account as "Gỡ liên kết Telegram", and SHALL appear in the customer's own history. Gift redemptions SHALL keep the Telegram user they were claimed with, so relinking never makes a new-user gift claimable again. The customer MAY link again.

#### Scenario: Unlink from the user page
- **WHEN** the admin removes the link of an account linked to @alice with the reason "liên kết nhầm"
- **THEN** the account shows "Chưa liên kết", @alice receives a notice, and the audit tab shows the removal with the reason

#### Scenario: Search the list
- **WHEN** the admin searches "@alice" on `/dashboard/telegram`
- **THEN** only accounts whose Telegram username contains "alice" are listed

#### Scenario: Gift not claimable again
- **WHEN** an account that claimed a new-user gift with Telegram user 111 is unlinked and relinks to 111
- **THEN** a new-user gift is still refused for it
