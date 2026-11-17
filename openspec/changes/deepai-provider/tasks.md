## 1. Engine
- [x] 1.1 Registry entry `deepai` (free tier, OAuth only, OpenAI format, `api-key` auth)
- [x] 1.2 `deepaiClient.js`: machine digest (one per deployment), lane headers, check-in with per-account cache, live model catalog
- [x] 1.3 `DeepAIExecutor`: check-in before each request, identity headers

## 2. Sign-in
- [x] 2.1 `deepaiAuth.js` + OAuth provider module, exchange route without PKCE
- [x] 2.2 `OAuthModal`: loopback redirect URI and callback-URL paste

## 3. Dashboard / API
- [x] 3.1 Models route, connection test, `/v1/models` live resolver

## 4. Tests
- [x] 4.1 `test/deepai.test.js` (headers, check-in against a local stand-in, exchange, catalog)
- [ ] 4.2 Live sign-in and one chat request against DeepAI (needs the owner's account; not run in this session)
