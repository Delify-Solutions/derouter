# Image storage: system fallback and admin overview

## Why

After `image-storage` shipped, the admin could only see a customer's storage by opening that customer, and every customer without their own bucket was locked out of image models. The owner asked for a central place to manage image storage.

## What Changes

- **System storage.** The admin connects one S3-compatible storage on `/dashboard/storage`. While it is enabled and its last test passed, a customer without a usable storage of their own (none, failing, untested or switched off) has their images stored there instead of being refused. A customer with a working storage keeps using it.
- **Charging.** A failure on the system storage is never charged, because the bucket is the router's and not the customer's. It marks the system storage failing until it is re-tested, and the admin gets a Telegram alert when it goes from working to failing. The customer's error does not include the bucket's reason.
- **Admin overview.** `/dashboard/storage` lists every customer storage with its owner, bucket, status, last write and last error. It can be filtered by status, a row can be re-tested in place, and it counts the customers without a storage.
- **Customer page.** `/account/storage` says when the shared storage is serving the customer. The response carries only that fact, never the system storage's settings.

- **Local storage per customer.** On a customer's storage tab, the admin can switch on "Lưu ảnh trên máy chủ". That customer's images are then written to `DATA_DIR/generated-images/` and served from `/api/public/images/<name>`, taking precedence over any CDN. A failed write is free. The users table gets `imageStorageLocal` (schema 43). Each change is audited.

## Impact

- `src/lib/storage/userStorage.js`:
  - `SYSTEM_STORAGE_ID` (a reserved row in `userStorage`, so no schema change);
  - `systemStorageConfigSync`, `imageStorageForUserSync`, `storageOverviewSync`, `storageStatusOf`;
  - `storageViewSync` gains `systemFallback`.
- `src/sse/handlers/imageGeneration.js`: the fallback, the free system failure and the admin alert.
- `src/lib/storage/localImages.js` (new), plus the column `users.imageStorageLocal` with `SCHEMA_VERSION` 43.
- New routes `/api/storage`, `/api/storage/system`, `/api/storage/system/test`, `/api/users/[id]/storage/local` and `/api/public/images/[name]`. `/api/users/[id]/storage/test` now requires an existing user.
- UI:
  - `/dashboard/storage` and its sidebar entry "CDN ảnh";
  - `StorageConfigPanel` gains the `system` audience and an `onChange` callback.

## Ordering

This delta modifies requirements added by `image-storage`; archive `image-storage` first.
