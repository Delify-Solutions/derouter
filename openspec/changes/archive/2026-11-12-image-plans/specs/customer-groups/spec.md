## MODIFIED Requirements

### Requirement: A group decides models and plan access only
A group SHALL carry a name, an active flag and an optional model allow-list, and SHALL decide exactly two things: which models its members may call, and (through `plans.allowedGroupIds`) which plans its members may buy. The allow-list SHALL admit both text and image combos (a combo's `kind`), so an image plan's models can be enabled for the group that buys it; the admin picker SHALL list both kinds with the kind shown on each row, and SHALL NOT list web-search or web-fetch combos, which are not models a key calls. A group SHALL NOT carry RPM, TPM, budget or reset-window settings; the admin group form SHALL NOT offer them and the API SHALL ignore them. A group SHALL apply to customer accounts only, never to an admin key.

#### Scenario: Group form
- **WHEN** an admin opens the group form
- **THEN** it offers the name, the active switch and the model picker, with no RPM, TPM or budget field

#### Scenario: Image combo allowed
- **WHEN** an admin enables an image combo for a group
- **THEN** members of that group may call that image model on `/v1/images/generations`
