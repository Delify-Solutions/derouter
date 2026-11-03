## Purpose

The public sales page for the "AI doanh nghiệp" product at `/doanh-nghiep`. It explains the guarded, company-data chatbot with an animated pipeline, lists the business plans from plan data, and routes a visitor to sign up and create a bot.

## ADDED Requirements

### Requirement: Page structure
`/doanh-nghiep` SHALL render for everyone, with the shared landing navigation and footer. The page SHALL contain, in this order:
1. A hero with:
   - the heading "AI chatbot cho doanh nghiệp";
   - a one-paragraph value statement covering company data, staying on scope, and safety on sovereignty and political content;
   - a primary call to action "Tạo chatbot";
   - a secondary call to action "Xem bảng giá" that scrolls to the plans section;
   - the animated pipeline.
2. A features section with four items: "An toàn chủ quyền", "Đúng phạm vi doanh nghiệp", "Học từ dữ liệu công ty", "API riêng cho từng bot".
3. A "Cách hoạt động" section with steps: create a bot, upload documents, get an API key, connect to the app.
4. The business plans section.
5. An FAQ answering:
   - what data is stored;
   - what happens to off-topic questions;
   - how sovereignty questions are handled;
   - which file types are supported;
   - what happens when the plan expires.
6. A closing call to action.

"Tạo chatbot" SHALL link a visitor without a customer session to `/register?next=/account/business` and a signed-in customer to `/account/business`.

The page SHALL set its own title and description metadata.

#### Scenario: Signed-out visitor
- **WHEN** a visitor without a session clicks "Tạo chatbot"
- **THEN** the browser goes to `/register?next=/account/business`

### Requirement: Animated pipeline
The hero SHALL show an inline SVG diagram with five step chips connected by one path. The chips SHALL read "Câu hỏi", "Lọc an toàn", "Tài liệu công ty", "Trả lời", "Kiểm duyệt", in that order.

The animation SHALL play automatically and loop every 7 seconds, linear:
- a comet-shaped dash SHALL travel along the connector by animating `stroke-dashoffset`;
- each chip's border and icon SHALL switch to the accent colour in sequence, as the comet reaches it;
- a ping dot SHALL pulse on the last chip.

Under `prefers-reduced-motion: reduce`, every animation SHALL be disabled and the diagram SHALL show all chips in their resting state.

The diagram SHALL be decorative to assistive technology (`aria-hidden="true"`). A visually hidden text SHALL list the five steps.

Colours SHALL meet WCAG AA contrast in light and dark themes. The diagram SHALL use square chips with 1 px borders and no shadows or gradients.

#### Scenario: Reduced motion
- **WHEN** the page is rendered with `prefers-reduced-motion: reduce`
- **THEN** no element of the diagram has a running animation

#### Scenario: Steps announced
- **WHEN** a screen reader reads the hero
- **THEN** it reads the five steps as text and skips the SVG

### Requirement: Business plan cards
The plans section SHALL render one card per active plan whose product line is `business`, in plan sort order. Each card SHALL use the same price, term, credit, duration, limit, featured and "Chưa mở bán" rules as the main landing plan cards, plus two lines:
- "Tối đa <maxBots> bot";
- "Dung lượng tài liệu <size>", where size is shown in MB or GB.

The "Chọn <plan name>" control SHALL link a visitor without a session to `/register?next=/account/plans?plan=<code>`, and a signed-in customer to `/account/plans?plan=<code>`.

When no business plan is active, the section SHALL show "Gói doanh nghiệp sắp mở bán" instead of cards.

#### Scenario: One business plan
- **WHEN** plan "biz-start" is active with productLine `business`, maxBots 2 and maxKbBytes 20 MB, and plan "go" is active with productLine `api`
- **THEN** `/doanh-nghiep` shows only the "biz-start" card, including "Tối đa 2 bot" and "Dung lượng tài liệu 20 MB"
