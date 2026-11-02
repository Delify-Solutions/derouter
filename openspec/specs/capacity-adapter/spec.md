# capacity-adapter Specification

## Purpose
The Vision Adapter (capacity adapter) sends a request that carries an image or audio to a capable model from an admin-chosen pool when the model the client asked for cannot read it — and only then, and only for the models the admin chooses.
## Requirements
### Requirement: Adapter scope
Each adapter capability (vision, audio input) SHALL carry `scope`: `all` (default; every requested model, the original behaviour) or `selected` with `targets`, the requested model names (combo names or `provider/model`, exactly as the client sends them) it covers. A request SHALL be switched to the pool only when it needs the capability, the capability's adapter is enabled and covers the requested name, the requested model does not declare the capability, and none of its own models has it. A combo that declares the capability in its stored capabilities (`meta.capabilities`, the values `/v1/models` advertises) SHALL never be switched for it. `selected` with no targets switches nothing. The admin page SHALL offer "Mọi model" / "Chỉ model chọn" per capability and a picker of combo names (free text allowed) for the targets. Settings saved before this change SHALL behave as `all`.

#### Scenario: Combo with vision is not switched
- **WHEN** the vision adapter is on with scope `all` and a client sends an image to combo "DeepSeek-V4.1-Flash", whose capabilities declare vision
- **THEN** the request is answered by the combo's own model, not by the adapter pool

#### Scenario: Only selected models are adapted
- **WHEN** the vision adapter is scoped to "Cheap" and a client sends an image to "Cheap" and another to "Other" (neither has vision)
- **THEN** the request to "Cheap" goes to the vision pool and the request to "Other" goes to its own model unchanged
