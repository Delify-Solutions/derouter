## 1. Storage

- [x] 1.1 `SYSTEM_STORAGE_ID` row; `systemStorageConfigSync`, `imageStorageForUserSync`, `storageOverviewSync`, `storageStatusOf`; `systemFallback` in the storage view
- [x] 1.2 Image handler: fallback to the system storage; a system failure is free, marks it failing, alerts the admin once and hides the reason

## 2. Admin

- [x] 2.1 `/api/storage` (overview), `/api/storage/system` (GET, PUT, DELETE) and `/test`
- [x] 2.2 `/api/users/[id]/storage/test` requires an existing user
- [x] 2.3 `/dashboard/storage` page (system form, filtered customer table, re-test per row) and sidebar entry
- [x] 2.4 `StorageConfigPanel`: `system` audience, fallback notice, `onChange`

## 3. Local storage

- [x] 3.1 `users.imageStorageLocal`, `SCHEMA_VERSION` 43; `src/lib/storage/localImages.js` (atomic write, strict names, usage)
- [x] 3.2 Precedence over every CDN; a failed write is free and marks nothing
- [x] 3.3 `/api/public/images/[name]` (public, nosniff, sandbox CSP) and `/api/users/[id]/storage/local` (audited)
- [x] 3.5 Origin from `publicBaseUrl` or the forwarded host, never the bind address; 2 GB free-space floor; streamed reads; async cached usage scan
- [x] 3.4 Admin toggle on the customer tab, customer notice, list and disk usage on `/dashboard/storage`

## 4. Verification

- [x] 4.1 `test/image-storage.test.js`: fallback order, free system failure, admin alert, overview, local storage
- [x] 4.2 `npm run lint`, `npm test`, `npm run build`
