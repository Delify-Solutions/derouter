## Why

An image model answers with the upstream's own link (for example `https://image-create.…/v1/images/files/….png`). The customer sees where the router buys its images, and the image lives only as long as that upstream keeps it. The owner wants every generated image stored on storage the customer controls, and only that storage's link returned.

## What Changes

- **A customer connects an S3-compatible storage** on a new page `/account/storage` ("CDN ảnh"): Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO or any other S3 API.
  - The form takes endpoint, region, bucket, Access Key ID and Secret, plus an optional public base URL, folder, path-style switch and on/off switch.
  - "Lưu & kiểm tra" saves, then uploads a small file, reads it back through the link and deletes it.
  - The secret is encrypted at rest (`encryptSecret`) and never returned. The key id is shown masked. A blank field keeps the stored value.
- **The admin sees and sets it** on the user detail page (tab "CDN ảnh"), through `/api/users/[id]/storage`. Saving and removing are written to the user's audit log.
- **A customer key needs a storage to use image models.**
  - Without an enabled storage, `/v1/images/generations` (and the account chat's image mode) answers 403 with a message pointing to `/account/storage`, before any upstream call.
  - Admin and local keys are unchanged.
- **Generated images are re-hosted.**
  - Every image is taken from the upstream response (link downloaded, or inline base64), its type checked from the bytes (PNG, JPEG, WebP, GIF, at most 25 MB), and uploaded to `<folder>/images/<date>/<uuid>.<ext>`.
  - `data[].url` becomes the storage link: the public base URL plus the key, or a presigned GET link valid 7 days when no public base is set. An inline `b64_json` the client asked for stays and gains the link. A binary response keeps its bytes and gains an `X-Image-Url` header.
  - A customer's image request is never streamed.
  - All or nothing for the response: if any image cannot be stored, the answer is a 502 that names the reason and contains no upstream link. Only `created`, `data[].{url, b64_json, revised_prompt}` and `usage` are returned.
  - Charging: usage is saved after every image is stored. A failure is free only while no image byte reached the customer's endpoint (download failed, not an image, over 25 MB, endpoint blocked). Once bytes were sent, the request is charged: the endpoint belongs to the customer, so "stored, then answered an error" must not become a free image.
  - A failed upload marks the storage as failing. Image requests are refused until the storage passes a test again, so a broken bucket costs at most one request. A storage must pass a test before its first image request.
  - Every image, whether downloaded, inline or a data URL, is capped at 25 MB, and downloads are read as a stream with that cap.
- **Requests to a customer's endpoint cannot reach inside.**
  - At save time, the endpoint and public link are resolved and refused if they point inside.
  - At connect time, the address actually dialed is checked, so DNS rebinding cannot reach an internal service.
  - Only https is spoken, and no redirect is followed.
  - Downloads of upstream links go through the existing SSRF guard.
  - Tests are limited to 10 per 10 minutes per customer.
- **Deleting an account deletes its storage row** and the encrypted secret in it.
- **Schema 42:** table `userStorage`, one row per account.

## Capabilities

### Added Capabilities
- `image-storage`: the customer's own image storage, the requirement to have one for image models, and the re-hosting of generated images onto it.
