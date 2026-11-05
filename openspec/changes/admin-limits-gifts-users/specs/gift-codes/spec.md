## MODIFIED Requirements

### Requirement: Editing a code
The admin gift code page SHALL offer "Sửa" on every code. It SHALL open the same form as creation, prefilled, and allow editing every field:
- the code string;
- what it grants (plan or custom credit, top-up amount, credit and duration);
- RPM/TPM;
- the total redemptions and the per-user limit;
- the start and expiry dates;
- the new-user flag;
- the note.

The following rules SHALL apply:
- The total SHALL NOT be set below the number of redemptions already made.
- The start SHALL NOT be later than the expiry.
- A new code string SHALL follow the rules for admin-chosen codes, and SHALL NOT match any other code that is not deleted.
- When the promo popup names the code being renamed, the popup SHALL be updated to the new string in the same write.

A change SHALL apply to redemptions made after it. Purchases already granted by the code SHALL keep what they received. The dialog SHALL say so when the code has been redeemed.

#### Scenario: More uses for an exhausted code
- **WHEN** a code with 2 of 2 uses taken is edited to 5 uses
- **THEN** three more accounts can redeem it

#### Scenario: Gift changed after redemption
- **WHEN** an admin changes a redeemed $5 credit code to $50
- **THEN** the next redeemer receives $50 and the earlier redeemers keep their $5 purchases

#### Scenario: Rename a code
- **WHEN** an admin renames code OLDNAME to NEWNAME
- **THEN** NEWNAME can be redeemed and OLDNAME is reported as not existing

#### Scenario: Rename the popup's code
- **WHEN** the promo popup shows code OLDNAME and an admin renames it to NEWNAME
- **THEN** the popup shows NEWNAME

## ADDED Requirements

### Requirement: Gift code rates
A gift code SHALL carry optional `rpm` and `tpm`, entered in the create and edit form: empty = the plan's own (none for a credit gift), 0 = no limit, or a positive integer. Each purchase the code grants SHALL carry these values as its per-purchase rate override (spec plan-templates "Per-purchase rate override"). The code list SHALL show them when set.

#### Scenario: Rate-limited credit gift
- **WHEN** an admin creates a $5 credit code with RPM 15 and a customer redeems it
- **THEN** the customer's new purchase is limited to 15 requests a minute while it pays

### Requirement: Delete a gift code
The admin gift code page SHALL offer "Xóa" on every code, with a confirmation that states the outcome.

- **A code nobody redeemed** SHALL be removed.
- **A redeemed code** SHALL be soft-deleted, with these effects:
  - it disappears from the admin list and from the affiliate gift picker;
  - it can no longer be redeemed, assigned or edited;
  - its redemption history and the purchases it granted SHALL stay unchanged, and the history SHALL still show the code as customers typed it;
  - its string SHALL become free, so a new code may use it.

In both cases the code SHALL be unlinked, in the same transaction, from every place that uses it: the referral program's default welcome gift and the promo popup code SHALL be cleared, and each CTV's welcome-gift override SHALL be cleared and audited on that CTV. The confirmation SHALL name those places before the admin confirms, and the result SHALL say what was unlinked.

The on/off switch SHALL remain for pausing a code without deleting it.

#### Scenario: Unused code removed
- **WHEN** an admin deletes a code with 0 redemptions
- **THEN** the code no longer exists

#### Scenario: Used code hidden
- **WHEN** an admin deletes a code redeemed 3 times
- **THEN** it is gone from the list, entering it reports that the code does not exist, and the 3 redeemers keep their purchases

#### Scenario: Recreate a deleted string
- **WHEN** an admin deletes the redeemed code WELCOME and then creates a new code WELCOME
- **THEN** the new code is created, redeeming WELCOME uses the new code, and the old redemptions still show WELCOME

#### Scenario: Code in use is unlinked
- **WHEN** an admin deletes a code that is the referral default gift, the welcome gift of 2 CTVs and the popup code
- **THEN** the dialog lists those places, and after deleting the default gift and the popup code are empty and neither CTV has its own gift any more
