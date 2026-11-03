## MODIFIED Requirements

### Requirement: Plan cards come from plan data
The landing page SHALL render one card per active plan whose product line is `api`, in plan sort order. Business plans SHALL NOT appear on it; they are sold on `/doanh-nghiep`.

Each card SHALL show:
- name, description and price;
- "Nhận $<credit> credit dùng chung cho mọi model";
- "Dùng <N> ngày";
- one line per limit, "Tối đa $<max> mỗi <window label>";
- a featured badge when the plan is featured;
- an inert "Chưa mở bán" control when the plan is not purchasable.

Window labels SHALL be:

| Window (hours) | Label |
|---|---|
| 5 | `5 giờ` |
| 24 | `1 ngày` |
| 168 | `1 tuần` |
| any other N | `<N> giờ` |

No text on the page SHALL describe per-model limits.

The landing navigation SHALL include a "Doanh nghiệp" link to `/doanh-nghiep`.

#### Scenario: Go card
- **WHEN** plan "Go" is active with price $10, credit $250, 30 days and limits 5h/$20 and 168h/$80
- **THEN** its card shows "$10", "Nhận $250 credit dùng chung cho mọi model", "Dùng 30 ngày", "Tối đa $20 mỗi 5 giờ" and "Tối đa $80 mỗi 1 tuần"

#### Scenario: Business plan not on the main page
- **WHEN** an active plan has productLine `business`
- **THEN** the main landing page shows no card for it, and its navigation links to `/doanh-nghiep`
