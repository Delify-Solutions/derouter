## Decisions

- **D1 Storage**: a boolean in `combos.meta`, mirroring `cacheEstimation` (`withMaintenance` removes the key when off, so old combos stay byte-identical). Rejected: a new column (needs a schema bump for one flag) and a settings list (drifts when a combo is renamed or deleted; `meta` travels with the row).
- **D2 Where it is enforced**: `enforceKeyLimits`, the one function every LLM endpoint (chat, images, embeddings, audio, video) already calls with the model. It runs after the allow-list (a customer who may not call the model still gets 403) and before admission, so a refused request reserves nothing. It applies to admin keys as well as customer keys; requests without a key (the admin console's own tests) are not refused.
- **D3 Status code**: 503, code `model_maintenance`, type `server_error`, a Vietnamese message naming the combo. Not 403: the customer did nothing wrong, and clients retry 503.
- **D4 Nested combos**: a maintenance combo reached as a member of another combo is treated as unavailable by the combo's own fallback; only a direct call is refused.
- **D5 Multiplier base**: factor applies to a fixed base, not to the current field values, so repeated clicks do not compound. Decimal-safe: values are scaled in integer micro-units (1e6) and printed without trailing zeros.
