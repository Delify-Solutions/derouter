## ADDED Requirements

### Requirement: Customer image storage
A customer SHALL be able to connect one S3-compatible storage on `/account/storage`, giving the provider preset, endpoint, region, bucket, Access Key ID and Secret Access Key, plus an optional public base URL, folder, path-style switch and enabled switch. The endpoint and the public base URL SHALL be `https://` URLs without credentials, query or fragment, and SHALL NOT name an internal, loopback or link-local host. The secret SHALL be stored encrypted and SHALL never be returned by any API; the key id SHALL only be shown masked; leaving either blank on a later save SHALL keep the stored value. Saving SHALL test the storage by uploading a small file, reading it back through the link the customer would receive, and deleting it, and SHALL show the outcome. The admin SHALL be able to view, set, test and remove a customer's storage on the user detail page, and each admin save or removal SHALL be written to the user's audit log.

#### Scenario: Connect Cloudflare R2
- **WHEN** a customer saves an R2 endpoint, bucket, key pair and public base `https://pub-x.r2.dev`
- **THEN** the storage is stored with the secret encrypted, the test uploads, reads back and deletes a file, and the page shows "Đã kết nối"

#### Scenario: Internal endpoint
- **WHEN** a customer enters `https://127.0.0.1:9000` as the endpoint
- **THEN** the save is refused and nothing is stored

### Requirement: Image models need a storage
A request to `/v1/images/generations` made with a customer key SHALL be refused with HTTP 403 and a message pointing to `/account/storage` when the key's owner has no enabled storage, or has one whose last test or last upload failed or that was never tested, before any upstream call. Requests made with admin or local keys SHALL NOT need a storage.

#### Scenario: Not connected
- **WHEN** a customer without a storage asks for an image
- **THEN** the response is 403 naming `/account/storage`, and no upstream request is made

### Requirement: Generated images are re-hosted
For a customer key, every image of a successful image response SHALL be uploaded to the customer's storage before the response is returned, and the response SHALL carry that storage's link in place of the upstream's: the public base URL followed by the object key, or a presigned GET link valid 7 days when no public base URL is set. An inline `b64_json` SHALL be kept and SHALL gain the link; a binary response SHALL keep its bytes and gain an `X-Image-Url` header. Images SHALL be accepted only as PNG, JPEG, WebP or GIF detected from their bytes, up to 25 MB. The customer's request SHALL NOT be streamed. Only `created`, `data[].url`, `data[].b64_json`, `data[].revised_prompt` and `usage` SHALL be returned. When the response carries no image, or any image cannot be stored, the response SHALL be HTTP 502 naming the reason and SHALL contain no upstream link. When the storage itself failed, it SHALL then be marked failing until a test passes, and the reason SHALL be shown on the storage page; a response without a usable image SHALL NOT mark the storage. Usage SHALL be saved only after every image is stored. A failed request SHALL NOT be charged while no image byte reached the customer's endpoint, and SHALL be charged once any did.

Calls to a customer's endpoint SHALL use https only, follow no redirect, and refuse any internal address both when the storage is saved and when the connection is opened.

#### Scenario: Upstream link replaced
- **WHEN** the upstream answers `{"data":[{"url":"https://image-create.example/v1/images/files/x.png"}]}` for a customer with a public base `https://pub-x.r2.dev`
- **THEN** the customer receives `https://pub-x.r2.dev/images/<date>/<uuid>.png`, and the upstream link appears nowhere in the response

#### Scenario: Storage refuses the upload
- **WHEN** the customer's bucket no longer exists
- **THEN** the response is 502 "Không tìm thấy bucket" and the request is charged, because the image was sent to the endpoint; `/account/storage` shows the error, and the next image request is refused until the storage passes a test

#### Scenario: Nothing sent
- **WHEN** the generated image cannot be downloaded from the upstream
- **THEN** the response is 502 and nothing is charged
