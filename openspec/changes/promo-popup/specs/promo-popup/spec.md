## ADDED Requirements

### Requirement: Promotional popup
Admin → Nội dung SHALL offer a "Popup khuyến mãi" card with: on/off, title (≤120), body (≤600), gift code (letters, digits, dashes, ≤64), button text (≤40, default "Đăng ký nhận ưu đãi" with a code, "Đăng ký ngay" without), delay in seconds (0–120, default 3) and minutes before showing again (0–10080, default 5). The card SHALL show whether the saved popup is live, warn when the code is not an active, unexpired, not exhausted gift code, and preview the draft. Invalid values SHALL be refused with a Vietnamese message.

The popup SHALL show after the delay when it is on and has a title, body or code, unless the visitor closed the same content within the configured minutes (0 = show on every page load). Closing it SHALL only hide it for that window: it SHALL come back afterwards, including when the customer moves to another page.

It SHALL be shown on:
- the landing page;
- `/register`;
- `/docs` and every docs page;
- every `/account` page except `/account/gift`, only for a new account: one that never bought a plan and has not redeemed the popup's code. The account is re-checked each time the popup is about to open, so redeeming the code or buying a plan stops it without a reload.

Editing the title, body, code or button text SHALL show it again to visitors who closed the previous version. Close button, Esc and a click outside SHALL close it; following its button or sign-in link SHALL count as closing it. The page behind SHALL not scroll while it is open, and its button SHALL meet WCAG AA contrast in light and dark themes.

#### Scenario: First visit
- **WHEN** a visitor opens the landing page with the popup on, a code and a 3-second delay
- **THEN** the dialog opens after 3 seconds with the title, body, code and button

#### Scenario: Closed recently
- **WHEN** the visitor closed it 2 minutes ago and the repeat period is 5 minutes
- **THEN** it does not open

#### Scenario: Comes back after the window
- **WHEN** the visitor closed it 6 minutes ago, the repeat period is 5 minutes, and they open another page
- **THEN** it opens again

#### Scenario: New account in the account area
- **WHEN** a customer who never bought a plan opens `/account/keys`
- **THEN** the popup opens; after they buy a plan or redeem its code it no longer opens there

#### Scenario: Content changed
- **WHEN** the admin changes the code after the visitor closed the popup
- **THEN** it opens again on the next visit

### Requirement: Gift code hand-off
Clicking the code SHALL copy it to the clipboard and show "Đã copy"; when the browser refuses, the popup SHALL say to copy it by hand. The button SHALL lead a visitor to `/register?next=/account/gift?code=<CODE>` and a signed-in customer to `/account/gift?code=<CODE>`; for visitors the popup SHALL also offer sign-in with the same `next`. Copying the code or following either link SHALL remember the code in the browser for 7 days. After registration with automatic sign-in, or a customer sign-in, without a `next`, a remembered code SHALL send the customer to the gift page. `/account/gift` SHALL prefill `?code=` or else the remembered code, and a successful redemption SHALL forget the code and drop `?code=` from the address.

#### Scenario: Sign up from the popup
- **WHEN** a visitor clicks "Đăng ký nhận ưu đãi" and registers (no email verification)
- **THEN** they land on `/account/gift?code=WELCOME2026` with `WELCOME2026` in the field, and pressing "Nhập mã" redeems it

#### Scenario: Copied, then signed up later
- **WHEN** a visitor copies the code, closes the popup and registers from the navigation bar (no email verification)
- **THEN** they land on the gift page with the code prefilled

#### Scenario: Email verification on
- **WHEN** a visitor copies the code, registers from the navigation bar, verifies the email and signs in
- **THEN** sign-in finishes on the gift page with the code prefilled
