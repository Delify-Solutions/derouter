## Why

Production error log of 2026-11-21 (262 entries) showed two separate problems.

1. **One client's malformed request took the model down for everyone.** A client
   sent a Responses-shaped `tool_choice`; the upstream (an openai-compatible
   DeepSeek node) answered `400 invalid_request_error`, `param: tool_choice`. The
   translation bug is fixed (`convertToolChoice`), but the router still classified
   any 400 that is not a size problem as an account failure and put the account on
   a 30 s cooldown. Five accounts back one combo, so a handful of bad requests
   cooled all of them, and 105 requests that were themselves valid (chat and
   messages, no `tool_choice`) were answered in 12–17 ms with a 503
   "Invalid input" and no upstream call.
2. **A model typed in another case was refused.** The combo is `DeepSeek-V4.1-Flash`;
   customers sent `deepseek-v4.1-flash` and got `403 model not in your list`. Combo
   lookup, the "customers call combos only" check, per-combo settings and pricing
   all compare the name exactly.

## What Changes

- A 400/422 that is the provider's own validation error (`type:
  "invalid_request_error"`, or a non-null `param` naming the refused field) is a
  property of the request: no cooldown, no account lock, no retry on another
  account. A combo still moves to its next model. A message naming a credential,
  permission, billing or account problem keeps the account-level handling.
- A client's model string is matched to a combo ignoring case. It is canonicalised
  once where each handler reads the request, so key enforcement, plan admission,
  pricing, usage and the response all use the combo's own spelling. An exact match
  wins; a case-insensitive match is used only when exactly one combo has that
  spelling.
- Creating or renaming a combo is refused when another combo already has the same
  name ignoring case.

## Capabilities

### Modified Capabilities
- `upstream-error-handling`: the "does not lock the account" requirement now covers
  provider validation errors, not only size refusals.
- `api-access-enforcement`: combo names are matched ignoring case.

## Impact

- `open-sse/config/errorConfig.js`, `open-sse/services/accountFallback.js`
- `src/lib/db/repos/combosRepo.js` (`canonicalComboName`, `findComboByNameIgnoringCase`)
- `src/sse/handlers/{chat,embeddings,imageGeneration,tts,stt,videoGeneration}.js`
- `src/app/api/combos/route.js`, `src/app/api/combos/[id]/route.js`
- `test/upstream-errors.test.js`, `test/model-case.test.js`
