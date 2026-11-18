## 1. Storage

- [x] 1.1 `src/lib/storage/s3.js`: SigV4 header signing and presigned GET (checked against AWS's published vectors), PUT and DELETE
- [x] 1.2 `userStorage` table, `SCHEMA_VERSION` 42
- [x] 1.3 `src/lib/storage/userStorage.js`: form validation (https, public host, bucket, folder), encrypted secret, public view, save/delete, test, re-hosting

## 2. Image requests

- [x] 2.1 Customer key without an enabled storage → 403 before any upstream call
- [x] 2.2 Re-host every image; rewrite links; binary gets `X-Image-Url`; no streaming for customers
- [x] 2.3 Usage saved only after every image is stored; a failure is free only while no image byte reached the customer's endpoint; a storage failure marks the storage failing until it is re-tested

## 3. Pages

- [x] 3.1 `/api/account/storage` (GET, PUT, DELETE) and `/test`; `/account/storage` page and menu entry
- [x] 3.2 `/api/users/[id]/storage` (GET, PUT, DELETE, audited) and `/test`; "CDN ảnh" tab on the user page
- [x] 3.3 Shared `StorageConfigPanel`

## 4. Verification

- [x] 4.1 `test/image-storage.test.js`
- [x] 4.2 `npm run lint`, `npm test`, `npm run build`
