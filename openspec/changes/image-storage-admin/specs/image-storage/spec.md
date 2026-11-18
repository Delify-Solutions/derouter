## MODIFIED Requirements

### Requirement: Image models need a storage
A request to `/v1/images/generations` made with a customer key SHALL use the router's disk when the admin picked the key's owner for local storage. Otherwise it SHALL use the key owner's storage when it is enabled and its last test or upload succeeded. Otherwise it SHALL use the system storage when one is enabled and its last test or upload succeeded. With neither, the request SHALL be refused with HTTP 403 before any upstream call, with a message pointing to `/account/storage`. Requests made with admin or local keys SHALL NOT need a storage.

#### Scenario: Not connected
- **WHEN** a customer without a storage asks for an image and no system storage is usable
- **THEN** the response is 403 naming `/account/storage`, and no upstream request is made

#### Scenario: System storage fallback
- **WHEN** a customer without a working storage asks for an image while the system storage is enabled and tested
- **THEN** the image is stored on the system storage and the customer receives its link

### Requirement: Generated images are re-hosted
For a customer key, every image of a successful image response SHALL be uploaded to the storage resolved for the request (the router's disk, the customer's own, or the system storage) before the response is returned, and the response SHALL carry that storage's link in place of the upstream's: the public base URL followed by the object key, or a presigned GET link valid 7 days when no public base URL is set. An inline `b64_json` SHALL be kept and SHALL gain the link; a binary response SHALL keep its bytes and gain an `X-Image-Url` header. Images SHALL be accepted only as PNG, JPEG, WebP or GIF detected from their bytes, up to 25 MB. The customer's request SHALL NOT be streamed. Only `created`, `data[].url`, `data[].b64_json`, `data[].revised_prompt` and `usage` SHALL be returned. When the response carries no image, or any image cannot be stored, the response SHALL be HTTP 502 and SHALL contain no upstream link; it SHALL name the reason, except that the reason of a failure on the system storage or the router's disk SHALL NOT be shown to the customer. When the storage itself failed, it SHALL then be marked failing until a test passes, and the reason SHALL be shown on its storage page; a response without a usable image SHALL NOT mark the storage. Usage SHALL be saved only after every image is stored. On the customer's own storage, a failed request SHALL NOT be charged while no image byte reached the customer's endpoint, and SHALL be charged once any did; on the system storage or the router's disk, a failed request SHALL NOT be charged.

Calls to a storage endpoint SHALL use https only, follow no redirect, and refuse any internal address both when the storage is saved and when the connection is opened.

#### Scenario: Upstream link replaced
- **WHEN** the upstream answers `{"data":[{"url":"https://image-create.example/v1/images/files/x.png"}]}` for a customer with a public base `https://pub-x.r2.dev`
- **THEN** the customer receives `https://pub-x.r2.dev/images/<date>/<uuid>.png`, and the upstream link appears nowhere in the response

#### Scenario: Storage refuses the upload
- **WHEN** the customer's own bucket no longer exists
- **THEN** the response is 502 "Không tìm thấy bucket" and the request is charged, because the image was sent to the endpoint; `/account/storage` shows the error, and the next image request goes to the system storage if one is usable, otherwise it is refused until the storage passes a test

#### Scenario: Nothing sent
- **WHEN** the generated image cannot be downloaded from the upstream
- **THEN** the response is 502 and nothing is charged

## ADDED Requirements

### Requirement: System image storage
The admin SHALL be able to connect one system storage on `/dashboard/storage`. It SHALL accept the same fields, validation, encrypted secret and save-then-test as a customer storage. A failure while storing on the system storage SHALL NOT be charged and SHALL mark the system storage failing until a test passes. When the system storage goes from working to failing, the admin SHALL be notified over Telegram. The customer's error SHALL NOT include the system storage's failure reason. A customer's storage page SHALL only show whether the system storage is serving them, never its settings.

#### Scenario: System bucket down
- **WHEN** the upload to the system storage fails
- **THEN** the customer gets 502 "không bị tính phí", the admin is alerted, and customers without their own storage are refused until the admin re-tests it

### Requirement: Admin storage overview
`/dashboard/storage` SHALL list every customer storage with:
- the owner, bucket, endpoint and returned link;
- a status: connected, failing, untested or off;
- the last test time and the last error.

It SHALL count customers without a storage and SHALL filter by status. It SHALL let the admin re-test a row and open the customer's storage tab. It SHALL never show a secret, and key ids SHALL be masked.

#### Scenario: Find broken storages
- **WHEN** the admin filters by "Lỗi"
- **THEN** only the customers whose storage last failed are listed, each with its error and a "Kiểm tra lại" button

### Requirement: Local image storage
The admin SHALL be able to switch "Lưu ảnh trên máy chủ" on or off for a customer on that customer's storage tab, and each change SHALL be written to the customer's audit log. While it is on:
- the customer's generated images SHALL be written under `DATA_DIR/generated-images/` and linked as `<public origin>/api/public/images/<yyyymmdd>-<uuid>.<ext>`;
- this SHALL take precedence over the customer's own storage and the system storage, and the customer SHALL need no storage of their own;
- a failed write SHALL NOT be charged and SHALL NOT mark any storage failing.

The public origin SHALL be `settings.publicBaseUrl` when set, otherwise the host forwarded by the reverse proxy (`x-forwarded-host` or `host`, with `x-forwarded-proto`), and SHALL never be the server's bind address or a loopback host; when no usable origin is known, the request SHALL be refused with HTTP 403 before any upstream call. A write SHALL be refused, uncharged, when it would leave less than 2 GB free on the data volume, and the failure SHALL be logged with its error code. `/api/public/images/<name>` SHALL serve only names of that exact form (PNG, JPEG, WebP or GIF) without authentication, with `nosniff` and a sandboxing CSP, streaming the file. `/dashboard/storage` SHALL list the customers picked, the number and total size of the stored files, and the free space.

#### Scenario: Picked customer
- **WHEN** the admin switches local storage on for a customer who also has an R2 bucket, and that customer generates an image
- **THEN** the image is written to the router's disk and the customer receives `https://<site>/api/public/images/<yyyymmdd>-<uuid>.png`; nothing is uploaded to R2

#### Scenario: Traversal
- **WHEN** someone requests `/api/public/images/..%2Fstorage.sqlite` or any name not of the form `<yyyymmdd>-<uuid>.<png|jpg|webp|gif>`
- **THEN** the request is refused (400 by the path guard, or 404) and no file is read

#### Scenario: No public origin
- **WHEN** `publicBaseUrl` is empty and the request reaches the server without a forwarded host (only the bind address `0.0.0.0:20128`)
- **THEN** a picked customer's image request is refused with 403 and no link to `0.0.0.0` is ever returned
