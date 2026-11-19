## ADDED Requirements

### Requirement: The Qoder provider page lists the account's live catalog
The Qoder provider page SHALL list the active account's live model catalog. The list SHALL contain every key the chat router accepts: first the catalog's models with Qoder's display names, then the static fallbacks the router also routes. The static registry SHALL be used only while the catalog is loading or when it cannot be read. A "Tải model mới nhất" button SHALL re-read the catalog from Qoder. Loading the page SHALL NOT call Qoder when the account's catalog is cached.

#### Scenario: Qoder adds a model
- **WHEN** the catalog publishes `qmodel_latest_preview`, which is not in the static registry
- **THEN** the page lists it under its Qoder display name, without a code change

#### Scenario: A key the account no longer has
- **WHEN** the static registry lists `lite` but neither the catalog nor the static fallbacks contain it
- **THEN** the page does not list `lite`
