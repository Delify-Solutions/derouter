## MODIFIED Requirements

### Requirement: Navigation and language
The account navigation SHALL be, in order: `Tổng quan` (/account), `Chat` (/account/chat), `Model` (/account/models), `Gói của tôi` (/account/plans), `Nhật ký credit` (/account/ledger), `Mã quà tặng` (/account/gift), `Giới thiệu` (/account/affiliate, only when the affiliate program makes it available), `API key` (/account/keys), `Lịch sử dùng` (/account/usage), `Thông báo` (/account/notifications, with the unread count), `Tài khoản` (/account/settings), then `Kênh Telegram` (opens the admin's channel in a new tab) when one is set. Every account page SHALL be in Vietnamese.

On screens narrower than the `lg` breakpoint the navigation SHALL be a tab bar fixed at the bottom of the screen with `Tổng quan`, `Gói`, `Mã quà`, `Thông báo` (with the unread count) and `Thêm`. `Thêm` SHALL open a sheet listing every other destination, the Telegram channel link when set, and sign-out. The bar and the sheet SHALL use a translucent, blurred ("liquid glass") surface with rounded corners, as a documented exception to `openspec/ui-dna.md` limited to this navigation. The sheet SHALL be a modal dialog that closes on choosing an item, Escape, a tap outside and a route change; moves focus into the sheet when opened and back to `Thêm` when closed; keeps keyboard focus inside and the page behind it inert while open. The current page SHALL be marked with more than colour, in the bar (on `Thêm` when the page is in the sheet) and in the sheet. Animations SHALL drop under reduced motion and the surfaces SHALL become opaque under reduced transparency. Text SHALL meet WCAG AA in both themes, and page content SHALL never be hidden behind the bar.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

#### Scenario: Phone navigation
- **WHEN** a customer on a 390px-wide screen taps `Thêm` and then "API key"
- **THEN** the sheet lists the other destinations, the API key page opens, the sheet is closed, and `Thêm` is marked current

#### Scenario: Escape closes the sheet
- **WHEN** the sheet is open and the customer presses Escape
- **THEN** the sheet closes and focus returns to `Thêm`

#### Scenario: Unread count on the tab
- **WHEN** the customer has unread notifications
- **THEN** the `Thông báo` tab shows the count, with a text label for screen readers
