## Context

`checkFallbackError` answers two questions: is the credential at fault (account
rotation, cooldown) and is the request what the member refused (no cooldown, hand
the answer to the client; a combo still moves on). Only 413 and size-worded 400/422
were request errors. Everything else unmatched fell through to a 30 s transient
cooldown, which is right for a network blip and wrong for a client bug.

## Decisions

**Recognise the provider's own validation shape, not individual messages.** Messages
differ per provider ("Invalid input", "Unsupported parameter", "extra inputs are not
permitted"), so a text list would always lag. The stable signals are the OpenAI /
Anthropic `type: "invalid_request_error"` and a non-null `param`. Both name the
request.

**Keep a deny-list of account markers.** Some providers answer a bad key or a
suspended account with a 400 that also carries `invalid_request_error`. A message
containing `api key`, `credential`, `permission`, `billing`, `account`, `expired` and
similar stays on the account path, so a real bad key still falls through to the next
account. The cost of a false "account" is the old behaviour (a 30 s cooldown); the
cost of a false "request" would be hammering a dead key on every request. The list
therefore errs towards the account path.

**Credit and rate rules still win.** `ERROR_RULES` text rules (`credit balance is too
low`, `rate limit`, `overloaded`) run before the request check, so Anthropic's
low-credit 400 (also `invalid_request_error`) keeps its backoff.

**Canonicalise once, at the entry.** A case-insensitive lookup inside each consumer
would leave pricing, `comboStrategies[name]`, usage and the response spelling the
combo three ways. Reading the model through `canonicalComboName` where each handler
parses the request means everything downstream already sees the combo's spelling, and
`body.model` is rewritten so translators and the echoed `model` agree.

**Exact first, unique case-insensitive second, otherwise unchanged.** `provider/model`
ids are never touched (they contain `/`; case may matter to a provider). Two combos
that already differ only by case stay exact-match-only, because guessing between them
would route a customer to the wrong model and bill the wrong price. Creation and
rename now refuse such pairs so the ambiguity cannot grow.

## Risks

- A provider that returns `invalid_request_error` for a transient or account reason
  without any marker word would now not be cooled down. The request is still handed
  to the client (or the next combo member) once; it is not retried in a loop, and the
  account marker list is extendable.
- `getComboByName` itself stays exact: the combo admin API relies on exact lookup.
- `GET /v1/models/{id}` still matches combo names exactly; it only describes a model and bills nothing, so it is left for a separate change.
- `markAccountUnavailable` (`src/sse/services/auth.js`) calls `checkFallbackError` without the provider, so provider-scoped rules (codebuddy-intl, nvidia, codex) do not fire on the account path while they do in combos. That predates this change and is left alone.
