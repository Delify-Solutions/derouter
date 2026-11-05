## Why

The owner asked for:
- a **Model** page and a **Telegram channel** link both on the public site and in the customer area;
- a **Thông báo** (notifications) page in the customer area with both admin announcements and the customer's own notifications;
- Telegram notification settings next to it;
- the **reason** of a model discount shown wherever a discount is shown.

Today the model prices live only inside the landing pricing table and the overview's model list; announcements exist only as Telegram broadcasts (customers without Telegram never see them); personal notifications exist only as Telegram messages; and the discount `label` is admin-only.

## What Changes

- **Discount reason**: the existing `label` of a discount rule becomes "Lý do giảm giá" (admin form wording) and is shown to customers next to "Giảm X%": landing pricing, the new model pages, the public usage page's model table, and the account usage history (from the rule ids stored on each request).
- **Model pages**:
  - public `/models`: every model of the default customer group with list price, discounted price, reason and end date (same data as the landing pricing table); the landing "Model" nav item links here;
  - `/account/models` ("Model"): the models the customer's group allows, with the customer's own discounts (group + paying plan), reason, end, kind and a copy button.
- **Announcements** (new table `announcements`): admin page `/dashboard/announcements` ("Thông báo") to create, edit and delete them (title, body, "Quan trọng" flag), with an option to also send it through the existing Telegram broadcast.
- **Personal notifications** (new table `customerNotifications`): every message the system sends a customer through `notifyCustomer` (billing, expiry, security) is also stored for the web, whether or not Telegram is linked or the group is muted on Telegram. Broadcasts are not stored per customer (they are announcements).
- **`/account/notifications` ("Thông báo")**: tabs "Thông báo chung" and "Của bạn", a "Telegram" section with the channel button and the existing link + per-group Telegram settings. The menu item shows an unread count; opening the page marks everything read (`users.notificationsSeenAt`).
- **Telegram channel**: setting `telegramChannelUrl` (a `https://t.me/...` link) edited on `/dashboard/telegram`. When set: "Kênh Telegram" in the landing nav (desktop and mobile) and footer, in the customer menu, and a join button on the notifications page.

## Capabilities

### Modified Capabilities
- `customer-portal`: navigation, model page, notifications page.
- `model-discounts`: the reason is shown to customers.

## Impact

- Schema: tables `announcements`, `customerNotifications`; column `users.notificationsSeenAt`; `SCHEMA_VERSION` 33.
- New: `src/lib/models/priceList.js`, `src/lib/notify/inbox.js`, `src/lib/telegram/channel.js`, `ModelPriceTable.js`; routes `/api/announcements` (admin), `/api/account/notifications` (+ `/seen`); pages `/models`, `/account/models`, `/account/notifications`, `/dashboard/announcements`.
- Changed: `modelDiscountsRepo.getActiveDiscountsForModels` (reasons), `modelCatalog.js`, `PricingSection.js`, usage receipts route + `UsageClient.js`, account usage page, `customerTelegram.notifyCustomer` (store), settings validation (`telegramChannelUrl`), `Navigation.js`, `Footer.js`, `AccountShell.js`, account layout, admin sidebar, discount admin form label.
