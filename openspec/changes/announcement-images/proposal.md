## Why

The owner wants an announcement (`/dashboard/announcements`) to carry an image — a promotion banner, a screenshot of a maintenance notice — both on the customer's notifications page and in the Telegram message it can send. Today an announcement is plain text only, and the Telegram broadcast can only send text.

## What Changes

- An announcement MAY carry one image (JPEG, PNG or WebP, at most 5 MB), detected from the file's bytes; anything else (SVG, GIF, a renamed file) is refused.
- The image is stored as a file under `DATA_DIR/announcement-images/<announcementId>`, with its type in `announcements.imageType` (schema 41). Deleting the announcement deletes the file; editing can replace or remove it.
- The admin form gets "Chọn ảnh / Đổi ảnh / Bỏ ảnh" with a preview; saving sends multipart. JSON saves keep working without an image.
- Customers see the image above the text on `/account/notifications`, served by `GET /api/account/notifications/[id]/image` (customer session); the admin page reads `GET /api/announcements/[id]/image`. Both serve with `nosniff`, a `default-src 'none'; sandbox` CSP and a private cache keyed on `updatedAt`.
- When "Gửi kèm qua Telegram" is on, the broadcast sends the image as a photo:
  - the text is its caption when it fits Telegram's 1024-character caption limit, otherwise the photo goes first and the text follows as its own message;
  - the photo is uploaded once and every later recipient gets Telegram's `file_id`;
  - a photo Telegram refuses outright (dimensions, size) is dropped and every recipient still gets the text;
  - `telegramBroadcasts.hasPhoto` records it and the history on `/dashboard/telegram` shows "+ kèm ảnh".

## Capabilities

### Modified Capabilities
- `telegram-notify`: announcements may carry an image, shown on the web and sent as a Telegram photo.
