## ADDED Requirements

### Requirement: Announcement image
An announcement SHALL carry at most one image. The server SHALL accept only JPEG, PNG or WebP, decided from the file's bytes and not from its name or declared type, of at most 5 MB, and SHALL refuse anything else with a Vietnamese message. The image SHALL be shown above the text on `/account/notifications` to signed-in customers and on the admin announcements page, served with `X-Content-Type-Options: nosniff` and a CSP of `default-src 'none'; sandbox`. Editing an announcement SHALL be able to replace or remove the image; deleting it SHALL delete the stored file.

When the announcement is also sent through Telegram, each recipient SHALL receive the image as a photo, with the message text as its caption when the text is at most 1024 characters, otherwise as a separate message right after the photo. The photo SHALL be uploaded once per broadcast and reused by Telegram file id for every other recipient. When Telegram refuses the photo itself, the broadcast SHALL drop it and still deliver the text to that recipient and every later one. The broadcast history SHALL show which broadcasts carried a photo.

#### Scenario: Promotion with a banner
- **WHEN** the admin posts an announcement with a 300 KB PNG and "Gửi kèm qua Telegram" on, to 50 linked customers
- **THEN** customers see the banner on `/account/notifications`, each Telegram recipient gets one photo captioned with the announcement, and the image is uploaded to Telegram once

#### Scenario: Long text
- **WHEN** the announcement text is 1500 characters and carries an image
- **THEN** each recipient gets the photo without a caption followed by the full text as a message

#### Scenario: Disguised file
- **WHEN** the admin uploads an SVG renamed to `banner.png`
- **THEN** the save is refused with "Chỉ nhận ảnh JPG, PNG hoặc WebP" and nothing is stored
