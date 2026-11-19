## 1. Implementation
- [x] 1.1 `toCommandCodeEffort`, `isCommandCodeUrl`, `commandCodeOpenAIBody` in `thinkingUnified.js`; the `commandcode` branch uses `toCommandCodeEffort`
- [x] 1.2 `applyThinking` `{ commandCodeNode }` (from `translateRequest`): Command Code effort only, never the model family's thinking shape (forced, compat, cross-format)
- [x] 1.3 `DefaultExecutor.transformRequest` maps the effort for OpenAI-compatible nodes at a Command Code host (Chat and Responses), strict mode included, without mutating the client body; triggers the live catalog refresh

- [x] 1.4 `forcedThinkingLevel` (used by chatCore): the forced Thinking level for a Command Code node is clamped against Command Code's catalog, not the model family's guessed levels

## 2. Tests
- [x] 2.1 `test/commandcode-openai-effort.test.js`: mapping table, host matching, Chat/Responses bodies, every effort × catalog shape through the executor stays in the enum, other hosts untouched, native provider still maps; pipeline tests (forced Off, compat, Claude client, GLM auto, Qwen, Kimi, Responses node, every effort × path), native `ultra`
- [x] 2.2 `npm test`, `npm run lint`
- [x] 2.3 proxy-transparency MODIFIED delta for the new strict-mode exception
