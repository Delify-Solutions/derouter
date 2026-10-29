# Reference: topsubre-php payment code

Read-only copy of the payment files from `github.com/duogxaolin/topsubre-php` (commit `12191128f044131ffb7324e033703cc1e24bf27b`, 2026-10-28), kept so the derouter port can be checked against the original behavior. **This PHP is never executed or imported by derouter.** Card (thẻ cào) payment files were intentionally left out.

| File | What it shows |
|---|---|
| `processing/payment/acb-lib.php` | ACB mobile-app client (`apiapp.acb.com.vn`): login, token cache, transaction history, notifications fallback, headers, proxy. Ported to `src/lib/payments/providers/acb.js` (design D10). |
| `processing/payment/bank.php` | Bank cron: picks web2m or ACB ("local") per bank, keeps incoming rows, matches code + exact amount, dedup by bank transaction id, notes late/wrong transfers for admin. |
| `processing/payment/pay.php` | Second cron that credits the wallet (not ported: derouter approves the order in the same transaction). |
| `processing/payment/binance.php` | Binance Pay history polling (`/sapi/v1/pay/transactions`, HMAC-SHA256), match on note = request id. |
| `app/controllers/recharge/index.php`, `bank.php`, `binance.php`, `app/controllers/recharge_binance.php`, `app/models/BinanceProvider.php` | Creating deposit requests, Binance provider settings, rate and promotion rules. |
| `app/services/DepositStatusRules.php` | Manual status changes refused when they could credit twice. |

Known defects not to copy (details in `../design.md` Context): the "no code" check in `bank.php` can never trigger; the self-repairing checksum in `pay.php`; bank passwords inside web2m URLs; two-step cron.

`acb-lib.php` contains default ACB mobile-app identifiers (client id, api key, device id, app version) in its constructor. They are app constants, not account credentials, but treat them as configuration: derouter reads them from provider config / environment, not from this file.
