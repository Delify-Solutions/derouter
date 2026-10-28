# derouter

A hosted AI proxy. Clients speak the OpenAI wire format to one base URL; derouter
resolves the requested model to a provider connection, streams the response back,
and meters the request against the caller's credit balance.

## What it is

- **Proxy** — `POST /v1/chat/completions` and the rest of the OpenAI surface,
  with per-key limits (RPM, TPM, budget, model allow-list) and combo fallback
  across provider connections.
- **Admin console** — providers, combos, keys, plans, orders, gift codes, usage
  and request logs, behind a dashboard login.
- **Customer account** — public signup, prepaid credit plans, self-service API
  keys, and a read-only usage view per key.

## Quick start

```bash
npm ci
cp .env.example .env.local        # if the file is present; otherwise set the vars below
npm run build
npm start                         # serves on port 20127 (PORT=xxxx to override)
```

Environment:

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | Directory holding the SQLite database, JWT secrets and logs. Defaults to `~/.derouter`. Set it to isolate an instance. |
| `PORT` | Listen port. `npm start` runs the standalone server, which reads `PORT` from the environment only (it ignores `--port`); it defaults to 20127. `start:source` runs the repo entry with `--port 20127`. |
| `JWT_SECRET` | Signing key for admin dashboard sessions. Generated and stored in `DATA_DIR` when unset. |
| `USER_JWT_SECRET` | Signing key for customer sessions. Generated and stored in `DATA_DIR` when unset. |
| `INITIAL_PASSWORD` | Admin password used until one is stored in the database. Defaults to `123456`; a remote first login with the default is refused. |
| `API_KEY_SECRET` | HMAC secret used when minting API keys. |
| `MACHINE_ID_SALT` | Salt for the per-install machine id. |

## Two surfaces

Admin: `/admin/ss` is the dashboard login. It is not linked from the public
site. The first login uses the default password `123456`; change it before
exposing the instance on a network.

Customer: `/register` creates an account, `/login` signs in, `/account` is the
overview. `/account/plans` sells credit, `/account/keys` issues API keys,
`/account/usage` lists requests. `/usage` also accepts a bare API key for anyone
who only holds a key.

`/` is the public landing page and redirects a live session to `/dashboard`
(admin) or `/account` (customer).

## Money model

Credit is an integer count of nano-USD (1 USD = 1e9 nano) held in the
`creditLedger`, so no float arithmetic ever touches a balance. Every request
debits the plans that back the key in first-expiry-first-out order; a plan's
remaining credit is decremented as it is consumed and the run is recorded with a
unique request key, which makes the debit idempotent on retry. When the balance
plus overdraft allowance is exhausted, the next request is rejected before it
reaches a provider. Plan credit is purchased through orders; gift codes grant
either credit or a plan and are limited per code and per account.

## Design

The UI is a Swiss-style infrastructure console: square corners, 1px hairline
borders, no shadows, monospaced figures. The rules and tokens live in
`openspec/ui-dna.md`; the tokens themselves are in `src/app/globals.css`.

## Development

```bash
npm run dev      # next dev on port 20127
npm test         # node --test over test/**/*.test.js
```

## License

MIT — see `LICENSE`.
