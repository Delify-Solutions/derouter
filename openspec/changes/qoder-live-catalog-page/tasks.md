## 1. Implementation
- [x] 1.1 `qoderDashboardModels`: live catalog first with Qoder's names and limits, then static fallbacks, then `enable:false` entries; `qoder/` ids
- [x] 1.2 Models API (Qoder): honors `?refresh=1` (page load uses the shared 1 h cache); passes the connection's provider id
- [x] 1.3 Provider page: Qoder in `LIVE_CATALOG_PROVIDERS` / `LIVE_CATALOG_REFRESH`; `qoder/` prefix stripped; failed read shown as such
- [x] 1.4 "Fetch Qoder Models" button and handler removed

## 2. Tests
- [x] 2.1 `test/qoder-catalog-scenes.test.js`: dashboard list order, names, limits, prefix, dropped static keys
- [x] 2.2 `npm test`, `npm run lint`
