## 1. Storage and API

- [x] 1.1 `announcements.imageType`, `telegramBroadcasts.hasPhoto`; `SCHEMA_VERSION` 41
- [x] 1.2 `src/lib/notify/announcementImage.js`: type detection from bytes, 5 MB limit, file storage by announcement id, multipart request reader, image response headers
- [x] 1.3 `POST /api/announcements` and `PATCH/DELETE /api/announcements/[id]` take, replace, remove and delete the image
- [x] 1.4 `GET /api/announcements/[id]/image` (admin) and `GET /api/account/notifications/[id]/image` (customer session)

## 2. Telegram

- [x] 2.1 `sendTelegramPhoto`: multipart upload or `file_id`, caption in HTML, blocked / rate-limited / photo-rejected outcomes
- [x] 2.2 `notifyCustomer({ photo })`: caption when it fits, otherwise photo then text; reuse the file id; drop a rejected photo
- [x] 2.3 `startBroadcast({ photo })`: record `hasPhoto`, pace two messages per recipient

## 3. UI

- [x] 3.1 Admin modal: pick / change / remove image with preview; list shows the image
- [x] 3.2 `/account/notifications` shows the image; broadcast history shows "+ kèm ảnh"

## 4. Verification

- [x] 4.1 `test/announcement-images.test.js`
- [x] 4.2 `npm run lint`, `npm test`, `npm run build`
