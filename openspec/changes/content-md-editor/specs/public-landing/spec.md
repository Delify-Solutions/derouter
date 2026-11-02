## ADDED Requirements

### Requirement: Announcement strip visibility
The landing page SHALL render the announcement strip above the hero only when the saved landing copy has `bannerEnabled` true AND a `bannerText` that is not blank after trimming. The strip SHALL be a link to `bannerHref` when one is set (a new tab for an `http(s)://` URL) and plain text otherwise. The admin content page's banner status SHALL apply this same rule.

#### Scenario: Enabled without text
- **WHEN** the saved copy has `bannerEnabled` true and `bannerText` "   "
- **THEN** the landing page shows no announcement strip

#### Scenario: Text without the switch
- **WHEN** the saved copy has `bannerText` "Có model mới" and `bannerEnabled` false
- **THEN** the landing page shows no announcement strip

#### Scenario: Live strip
- **WHEN** the saved copy has `bannerEnabled` true, `bannerText` "Có model mới" and `bannerHref` "/docs/bat-dau"
- **THEN** the landing page shows the strip "Có model mới" linking to `/docs/bat-dau`
