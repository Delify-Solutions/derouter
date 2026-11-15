## ADDED Requirements

### Requirement: Quick price multipliers on the combo price form
The combo price form SHALL offer the buttons x0.5, x1, x2 and x3. Pressing one SHALL set every price field (input, cache read, cache write, output, reasoning, image) to the base price times the factor, where the base is the pool price the form auto-fills from while the form still shows that auto-filled suggestion, and otherwise (an image combo, a combo that already has a saved price, or a price the admin typed or scaled) the field values at the first press. The factor SHALL apply to the base and not to the current field values, so pressing x2 and then x3 leaves 3 times the base and x1 restores the base. Results SHALL be computed in decimal arithmetic and rounded to at most 6 decimal places (0.1 x 3 gives 0.3), and empty fields SHALL stay empty. Pressing a button counts as an admin edit: the price is saved with the combo and later model changes do not overwrite it. A new list of models SHALL drop the remembered base. The buttons SHALL be keyboard operable, show the factor as text and be at least 24 px high.

#### Scenario: Multiply the pool price
- **WHEN** the form is auto-filled with input 3, output 15 and the admin presses x2
- **THEN** the fields show input 6 and output 30

#### Scenario: No compounding
- **WHEN** the admin presses x2 and then x3 on a base of input 0.1
- **THEN** the field shows 0.3, not 0.6

#### Scenario: Half price
- **WHEN** the admin presses x0.5 on a base of input 3
- **THEN** the field shows 1.5

#### Scenario: Saved or image price is never replaced by a pool price
- **WHEN** the admin opens a combo that has a saved price (or an image combo with price 0.04) and presses x2
- **THEN** the fields hold the saved values times 2 (image 0.08), never a price derived from a pool model

#### Scenario: Empty stays empty
- **WHEN** the reasoning field is empty and the admin presses x2
- **THEN** the reasoning field stays empty
