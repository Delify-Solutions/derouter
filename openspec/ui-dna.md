# UI DNA — derouter

The design system is a Swiss-style infrastructure console: hairline-bordered, flat, monospaced where it matters, hard-edged everywhere. Green marks action and current state; zinc neutrals carry everything else. Nothing floats, nothing glows, nothing is round.

Source of truth for tokens is `src/app/globals.css`. This document states the principles those tokens encode; when they disagree, the tokens win and this document gets corrected.

## 1. Design tokens

### Colour

Brand green ramp (both themes use this ramp for 50–300; the dark theme raises the mid-tone for contrast):

| Step | Hex | Typical role |
|------|-----|--------------|
| 50 | `#f0fdf4` | tinted fills at 10% opacity |
| 100 | `#dcfce7` | selected-row wash |
| 200 | `#bbf7d0` | chart series low |
| 300 | `#86efac` | hover on dark surfaces |
| 400 | `#4ade80` | brand in dark mode |
| 500 | `#16a34a` | brand in light mode, primary fill |
| 600 | `#15803d` | primary hover, brand text on light |
| 700 | `#14532d` | brand text on tinted light fill |
| 800 | `#0f3b1f` | deep accent, print/export only |
| 900 | `#052e16` | darkest accent |
| 950 | `#052e16` | alias of 900 |

Primary interactive colour: `#16a34a` in light, `#4ade80` in dark.

Surfaces:

| Token | Light | Dark |
|-------|-------|------|
| page background | `#ffffff` | `#09090b` |
| alternate background | `#fafafa` | `#18181b` |
| surface | `#ffffff` | `#18181b` |
| surface, raised one step | `#f4f4f5` | `#27272a` |
| surface, raised two steps | `#e4e4e7` | `#3f3f46` |
| sidebar | `rgba(255,255,255,.8)` | `rgba(9,9,11,.75)` |

Borders and text:

| Token | Light | Dark |
|-------|-------|------|
| border | `#e4e4e7` | `#27272a` |
| border, subtle | `#f4f4f5` | `rgb(255 255 255 / 0.08)` |
| text, primary | `#09090b` | `#fafafa` |
| text, muted | `#71717a` | `#a1a1aa` |
| text, subtle | `#a1a1aa` | `#71717a` |

Status: danger `#cf222e` (light) / `#ef4444` (dark), success `#16a34a`, warning `#F59E0B` (light) / `#fbbf24` (dark), info `#3B82F6` (light) / `#60a5fa` (dark). Status colour never stands alone — pair with an icon or label so it survives greyscale.

### Spacing

4px base. The working scale is 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48. Controls sit at 32 / 40 / 48px height (small / medium / large). Card padding starts at 24px; page sections break on 40–48px.

### Typography

Two families, no third:

- **Sans** — the interface voice for prose, headings, data labels. Humanist sans, weights 400–900. Line height 1.5 for body, 1.25 for headings.
- **Mono** — buttons, navigation, table cells holding identifiers or numbers, metadata eyebrows, badges, code. Weights 400–600.
- **Display** — a serif stack reserved for editorial statements. Use sparingly; it must never appear in a control or a table.

Type ramp: 11px metadata (uppercase, 0.14em tracking) → 12px mono control text → 14px body → 16px emphasised body → 20px section heading → 24px page title → 30–36px hero.

Uppercase is a *typographic role*, not emphasis: it marks eyebrows, navigation labels, and buttons. Prose is always sentence case.

### Radius

Zero. Every corner is square: cards, inputs, buttons, modals, badges, avatars, toasts, tooltips. A circle is allowed only for a status dot or a loading ring. Nothing else rounds.

### Shadow

Shadows are hairlines, not elevation. Two forms exist:

- inset bottom hairline, used on light containers, tinted to the border colour at ~70% (dark: white at 4%)
- a single `0 1px 2px` at 4% black, used only where a surface must separate from an identical surface

Depth is communicated by border, background step, and layout — never by a drop shadow. There is no layered or coloured shadow anywhere in the system.

### Z-index

Content → sticky header → sidebar overlay → drawer/modal → toasts/overlays. Each layer owns a distinct border or backdrop so stacking stays legible without shadows.

## 2. Component patterns

**Buttons** — square, mono, uppercase, letter-spaced, 12px. Three heights: 32 (compact/inline), 40 (default), 48 (prominent). Horizontal padding exceeds vertical so the label reads as a bar, not a box. Six variants: solid brand, outlined neutral, transparent-with-hover, ghost, solid danger, solid success. There is no shadow, no gradient, no scale-on-press; hover is a colour change only. Disabled states drop to 50% opacity and the not-allowed cursor.

**Inputs, selects, textareas** — 1px border, surface-filled, square. Focus replaces the border colour with brand green; no glow ring, no outline offset. Labels are 11px mono uppercase, tracked. Errors sit below the field in 11px danger text with an inline icon and state what failed. The placeholder is muted, never used as a label.

**Cards** — one 1px border, one surface fill, no shadow. A card's importance is expressed by border contrast and padding, not by elevation. Card headers pair an optional icon in a bordered square with a title; the icon container is never filled with brand colour unless the card is the primary action of the screen.

**Modals** — square container, 1px border, no shadow, no blur on the overlay (a flat 40% black dim only). The header is a fixed-height bar with a mono uppercase title on the left and a single square close control on the right that carries an accessible label. Body scrolls; footer is right-aligned and separated by a hairline. Dismissal: overlay click (when enabled) and Escape.

**Drawers** — same square, border-only treatment as modals, anchored right, separated from content by a 1px left border. Headers use the same mono uppercase title and square close control.

**Badges** — square, mono, uppercase, 10px, tracked. Tinted fill at 10%, 30% border, 700 text in light / 400 in dark. A dot may precede the label; it never replaces it.

**Tooltips** — small, square, dark fill, white 11px text, no arrow, no shadow, revealed on hover/focus within 150ms.

**Iconography** — a single outline icon set. Icons inside buttons inherit the button's text colour and size; standalone icon-only controls sit inside a bordered square with a label for assistive tech. No emoji as iconography.

## 3. Interaction & motion

- Transitions are 150ms, colour and border only. That is the entire motion vocabulary for controls.
- Content does not fade, scale, bounce, or slide in on load. Panels that must animate (drawer, toast) move once, linearly, and settle — they never loop.
- No non-user-triggered motion: no shimmer, no glow pulse, no blob drift, no auto-rotating carousel.
- Hover changes background, border, or text colour. It never moves or resizes the element.
- Active/pressed state is the hover state or one step darker — no scale transform.
- Loading is a single spinner or a skeleton with a static fill. Skeletons do not animate except through an opacity pulse where the region has no border.

## 4. Accessibility

- Text meets WCAG AA: 4.5:1 for body copy and 3:1 for large text and UI boundaries. Muted text is the floor, never decorative.
- Never use colour alone to convey state — pair it with an icon, a label, or a border-weight change.
- Every interactive element is reachable and operable by keyboard, with a logical tab order and no focus traps outside modals.
- Focus is visible: a 2px brand-green outline with a 2px offset on `:focus-visible`, never removed. Text fields and selects are the one exception — they replace their 1px border with the brand colour instead of drawing the outline.
- Icon-only controls carry an `aria-label` and, where the icon is ambiguous, a tooltip.
- Modal and drawer roots declare dialog semantics and expose a labelled close control; Escape closes them.
- Form fields are labelled; errors are associated with their field and announced.

## 5. Voice & tone

- Prose is sentence case, second person, present tense: "Keys are stored locally." Not "We will store your key."
- UPPERCASE belongs to navigation labels, button labels, eyebrows, and table headers — never to sentences.
- Numbers are raw and unrounded in mono: `1,204 ms`, `0.000000031 USD`. Money is integer nano-USD; show the unit once.
- Errors name the object, the failure, and the next action: "Provider key rejected — check the key and retry." No "Oops", no exclamation marks, no apology.
- Empty states describe what will appear here and offer the one action that fills it.
- Success confirmations are one line, past tense, and disappear. They do not congratulate.

## 6. Layout & responsive

- Content column maxes at 1280px with 2rem (32px) inline gutters, centred. Full-bleed is reserved for grids, tables that must scroll, and page backgrounds.
- Persistent sidebar is 288px on desktop and collapses to an off-canvas panel below the large breakpoint; the header survives collapse and always exposes the navigation trigger.
- Header is a sticky 64px bar with a 1px bottom border. Left: title and breadcrumb. Right: search, then utilities.
- Grids step 1 → 2 → 3 → 4 columns at 640 / 768 / 1024 / 1280px. Tables scroll horizontally rather than compress below their readable minimum.
- Density is consistent: 40px control rhythm, 24px card padding, 32px section gaps. Do not introduce a second spatial rhythm for a single screen.
- Background patterning (blueprint grid) is decoration for hero regions only, is masked so it fades out, and never sits under text or form controls.

## 7. Anti-patterns

- Gradients on surfaces, buttons, or icons.
- Blurred colour blobs, glow pulses, and animated backgrounds.
- Fake desktop chrome — traffic-light dots, window frames, title bars.
- Drop shadows standing in for hierarchy.
- Rounded cards, pill buttons, pill badges, circular avatars.
- Emoji used as icons or as status markers.
- Numbered markers on content that is not a sequence; step numbers only where order is real.
- Uppercase prose, exclamation marks, and congratulatory microcopy.
- Colour-only status signalling.
- Second typeface families, second spatial rhythm, or per-feature token overrides.

---

UI/UX work must read `openspec/ui-dna.md` before any visual change.
