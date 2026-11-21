## ADDED Requirements

### Requirement: Combo names are matched ignoring case
A model string that is not a `provider/model` id and equals the name of exactly one combo when compared ignoring case SHALL be treated as that combo, wherever a handler reads the request's model (chat, responses, messages, embeddings, images, speech, transcription, video, search, fetch). The combo's own spelling SHALL be used from then on, including as the name the response is masked with: for the group allow-list and plan model checks, "customers call combos only", combo maintenance, plan admission, pricing and discounts, per-combo settings, usage records, error and denial logs, and the `model` returned to the client. A name that equals a combo exactly SHALL always resolve to that combo. When two combos differ only by case, a name that matches neither exactly SHALL NOT be resolved by case. A `provider/model` id SHALL never be re-cased.

Creating a combo or renaming one SHALL be refused with "Combo name already exists" when another combo already has the same name ignoring case. Saving a combo under its own current name SHALL NOT count as a rename.

#### Scenario: Lower-case combo name
- **WHEN** a customer whose group lists `DeepSeek-V4.1-Flash` calls `deepseek-v4.1-flash`
- **THEN** the request is served as `DeepSeek-V4.1-Flash`, priced at that combo's price, recorded under that name, and not refused as "not in your list"

#### Scenario: Upstream id still refused
- **WHEN** a customer calls `zai/glm-5.3:pre`, in any case
- **THEN** the request is refused exactly as before

#### Scenario: Ambiguous spellings
- **WHEN** combos `Twin` and `twin` both exist and a client calls `TWIN`
- **THEN** the name is not resolved by case; `Twin` and `twin` each still resolve exactly

#### Scenario: Name collision by case
- **WHEN** an admin creates a combo `glm-5` while `GLM-5` exists
- **THEN** the request is refused with HTTP 400 "Combo name already exists"
