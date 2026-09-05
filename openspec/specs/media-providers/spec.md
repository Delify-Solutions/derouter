# media-providers Specification

## Purpose
Media provider routes for TTS (text-to-speech) voice lists across providers (Deepgram, ElevenLabs, Inworld, MiniMax, generic) and the media-providers UI. The actual audio generation goes through the proxy `/v1/audio/*` executors; these admin routes list available voices/models per provider.
## Requirements
### Requirement: Media voice-list routes over JSON

The Rust backend MUST serve the voice-list routes as JSON, all requiring auth (401 JSON without cookie): `GET /api/media-providers/tts/voices`, `GET /api/media-providers/tts/deepgram/voices`, `/elevenlabs/voices`, `/inworld/voices`, `/minimax/voices`. Each MUST fetch the live voice list from the provider (using stored credentials) and return it as JSON; on missing credentials it MUST return 400 `{"error":"<provider> not configured"}`.

#### Scenario: elevenlabs voices
- **WHEN** `GET /api/media-providers/tts/elevenlabs/voices` is called authenticated and ElevenLabs credentials exist
- **THEN** the response is the live voice list from ElevenLabs

#### Scenario: unconfigured provider
- **WHEN** the voice-list route for a provider with no credentials is called
- **THEN** the response is 400 `{"error":"<provider> not configured"}`

### Requirement: Media providers page in TypeScript

The media-providers pages (`[kind]`, `web`, `[kind]/[id]`, `[kind]/combo/[id]`) and their components (EmbeddingExampleCard, GenericExampleCard, SttExampleCard, TtsExampleCard, exampleShared) MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient.

#### Scenario: media page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the media-providers pages + components report 0 errors

