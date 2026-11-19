## ADDED Requirements

### Requirement: The Qoder model list includes the assistant scene
The router SHALL build a Qoder account's model list from the `chat` scene and the `assistant` scene of `/algo/api/v2/model/list`. When a model key appears in both, the `chat` entry SHALL be used. Every listed model SHALL be routable with its own catalog entry as `model_config`. The `quest`, `service_account`, `byok_enterprise` and `external_models` keys SHALL NOT be listed.

#### Scenario: A model published only for the Qoder app
- **WHEN** the catalog lists `glm-5.3` under `assistant` but not under `chat`
- **THEN** `glm-5.3` appears in the provider's model list and in `/v1/models`, and a chat request for it sends that entry as `model_config`

#### Scenario: The IDE-only shape
- **WHEN** the catalog holds only a `chat` array
- **THEN** the model list is the same as before this change
