## ADDED Requirements

### Requirement: Skill page

`/account/skills` ("Skill") SHALL list the skills the operator published for
customers, as specified in `customer-skills`, and SHALL carry the install guide
described there. The page SHALL answer a signed-in customer only; a navigation to
it without a session SHALL redirect to the sign-in page like every other page of
the account area.

#### Scenario: Signed-out visitor
- **WHEN** a visitor without a customer session opens `/account/skills`
- **THEN** they are redirected to the sign-in page and see no skill content
