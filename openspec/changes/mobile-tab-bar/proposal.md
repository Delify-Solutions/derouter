## Why

On phones the customer area opens every page through a hamburger in the header.
The owner wants navigation that feels like a phone app: a bottom tab bar in the
liquid-glass style.

## What Changes

- Below `lg`, a floating liquid-glass tab bar at the bottom of the screen replaces
  the header hamburger: `Tổng quan`, `Gói`, `Mã quà`, `Thông báo` (unread badge) and
  `Thêm`.
- `Thêm` opens a liquid-glass sheet above the bar with the remaining pages, the
  Telegram channel link and sign-out. It keeps the old panel's dialog behaviour.
- Page content gets bottom padding so the bar never hides the last content.

## Capabilities

### Modified Capabilities
- `customer-portal`: "Navigation and language" (phone navigation).

## Impact

- `src/app/account/components/MobileMenu.js`, `AccountShell.js`, `src/app/globals.css`
