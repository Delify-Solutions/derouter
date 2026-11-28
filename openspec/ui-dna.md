# UI DNA — derouter

The admin dashboard (`/dashboard/**`) follows Vuexy's design language: rounded corners, soft elevation shadows instead of hairline borders, a violet brand accent, and sentence-case labels throughout. It is rebuilt natively in React + Tailwind from the licensed Vuexy Bootstrap template kept at `vuexy-html-admin-template/` as a local design reference only (gitignored, never shipped, never imported as CSS/JS — see `openspec/changes/admin-accounts-rbac-vuexy/design.md` Decision 6). The customer account area (`/account/*`, `/login`, `/register`) is a separate system and is unaffected by this section — see §8.

Source of truth for tokens is `src/app/globals.css` (the `vx-*` block, group 7 of `admin-accounts-rbac-vuexy`). This document states the principles those tokens encode; when they disagree, the tokens win and this document gets corrected.

## 1. Design tokens

### Colour

| Token | Light | Dark | Role |
|-------|-------|------|------|
| `vx-primary` | `#7367f0` | `#7367f0` | brand, primary actions, focus ring |
| `vx-primary-hover` | `#675dd8` | `#8277f2` | primary hover |
| `vx-secondary` | `#808390` | `#808390` | neutral accent |
| `vx-success` | `#28c76f` | `#28c76f` | success status |
| `vx-danger` | `#ff4c51` | `#ff4c51` | destructive actions, errors |
| `vx-warning` | `#ff9f43` | `#ff9f43` | warnings |
| `vx-info` | `#00bad1` | `#00bad1` | informational |

Surfaces:

| Token | Light | Dark |
|-------|-------|------|
| page background | `#f8f7fa` | `#25293c` |
| surface | `#ffffff` | `#2f3349` |
| surface, raised one step | `#f3f2f3` | `#3a3d53` |
| surface, raised two steps | `#eaeaec` | `#44485e` |
| border | `#e6e6e8` | `#44485e` |

Text:

| Token | Light | Dark |
|-------|-------|------|
| heading | `#2f2b3d` | `#cfcde4` |
| text | `#2f2b3d` | `#e1def5` |
| text, muted | `#6d6b77` | `#9a9ab0` |
| text, subtle | `#97959e` | `#76778e` |

Status colour never stands alone — pair with an icon or label so it survives greyscale. Every `Badge` variant does this via its `icon`/`dot` prop.

### Spacing & sizing

4px base, same working scale as before (4 / 8 / 12 / 16 / 24 / 32 / 40 / 48). Controls sit at 32 / 40 / 48px height (small / medium / large). `--vx-navbar-height: 3.5rem`, `--vx-menu-width: 16.25rem` (`--vx-menu-collapsed-width: 4.375rem` when collapsed).

### Typography

Sentence case throughout — Vuexy does not use the old uppercase-eyebrow convention. One sans family for prose, headings, and controls; mono only for raw identifiers, numeric table columns, and code. Labels on form primitives (`Input`, `Select`) are 12px (`text-xs`), medium weight, muted colour — never uppercase/tracked.

### Radius

Named scale, used throughout instead of the old hard-zero: `vx-radius-xs` (0.125rem) → `sm` (0.25rem) → `md` (0.375rem, the default for inputs/buttons/badges) → `lg` (0.5rem, cards/modals/tables) → `xl` (0.625rem) → `2xl` (1rem) → `pill` (50rem, toggles/avatars/status dots). Nothing is square by default anymore; a flat corner is the exception, not the rule.

### Shadow

Real elevation shadows (`vx-shadow-xs` through `vx-shadow-xl`), not hairlines. A `Card` at rest carries `shadow-vx-xs`; it steps up on hover/interaction (`shadow-vx-sm`) rather than changing border colour. Modals use `shadow-vx-xl`. Gradients are still an anti-pattern (§7) — elevation comes from shadow + surface step, never a gradient fill.

## 2. Shared primitives (`src/shared/components/`)

These are the only components that should render chrome — every `/dashboard/**` page composes from them rather than hand-rolling markup. Each keeps the same prop API regardless of visual system, so call sites never needed to change shape, only wrapping.

- **Button** — rounded (`rounded-vx-md`), tonal by default. Variants: `primary`, `secondary`, `success`, `danger`, `warning`, `info`, `light`, `dark` (solid), plus a `-outline` tonal counterpart for all eight (`primary-outline`, `danger-outline`, …), and `ghost` for a borderless icon/text action. No shadow on rest, `loading` renders a built-in spinner (never a hand-rolled `animate-spin` override). Icon-only controls use a fixed square (`size-9 px-0`/`size-8 px-0`) with an `aria-label`.
- **Card** — no border by default (elevation carries the hierarchy), `rounded-vx-lg`, `shadow-vx-xs` at rest. `title`/`subtitle`/`icon`/`action` header slots; `Card.Section`, `Card.Row`, `Card.ListItem` sub-components for common internal layouts.
- **Input / Select** — rounded (`rounded-vx-md`), bordered, a focus ring (`ring-2 ring-vx-primary/15`) instead of a bare border swap. `Input` supports `icon`, `error`/`hint`, and an optional `onClear` (×) affordance.
- **Toggle** — a pill switch (`rounded-full`), `vx-primary` when on, `vx-surface-3` track when off. Replaces the old checkbox-styled switch.
- **Table** — a new primitive (did not exist before this design); `bare` skips its own rounded/shadow wrapper when nested inside a `Card` so tables are never double-boxed; `Table.HeaderCell` takes an `align` (`left`/`center`/`right`).
- **Modal** — rounded (`rounded-vx-lg`), `shadow-vx-xl`, no backdrop blur, a fixed 56px header bar with a square close control. `ConfirmModal` wraps it for a confirm/cancel footer.
- **Badge** — tonal fill (15% opacity), no border, sentence case, `rounded-vx-sm`. Sizes `xs`/`sm`/`md`/`lg`; `dot` and `icon` slots.
- **Pagination** — rounded page-number buttons built on `Button`; Vietnamese info line ("Hiển thị X–Y trong tổng Z kết quả") and page-size label ("Số dòng:").
- **Toast** — inline or floating dismissible message, `type` maps to a status colour + icon.
- **Sidebar / Header** — collapsible vertical menu (icon + label nav items), topbar with search and profile/utility controls on the right. Permission-based filtering (`viewablePageKeys` from the admin-accounts RBAC system) is unchanged by the visual system — it decides which nav items exist before any styling is applied.

No Bootstrap CSS and no jQuery are loaded anywhere in the app; "Vuexy" here means the visual language only, reimplemented as Tailwind utility classes and React components.

### What still carries the old neutral tokens, on purpose

A page composed entirely from the primitives above is fully on `vx-*` tokens. Markup that is genuinely one-off and matches no primitive — inline alert/notice banners (no shared `Alert` component exists), raw `<textarea>` fields (no shared multiline primitive exists), bespoke tab strips (no shared `Tabs` component exists), and dense stat-tile grids — was deliberately left on the pre-existing neutral tokens (`border-border`, `bg-surface`, `text-text-muted`, status-tinted `bg-{success,danger,warning}-500/10` banners) during the reskin, because every one of these is a consistent, repeated pattern across the whole admin rather than a one-off. Introducing a matching shared primitive for any of these (`Alert`, `Textarea`, `Tabs`) is a legitimate follow-up, not a bug in the reskin — do it as its own change, consistently, rather than inventing a one-off per page.

## 3. Interaction & motion

- Transitions are 150–200ms, colour/border/shadow. Hover on a `Card` may step its shadow up a level; hover on a `Button` changes fill/tone, never scale.
- No non-user-triggered motion: no shimmer, no glow pulse, no auto-rotating carousel.
- Loading is `Button`'s built-in `loading` spinner or a skeleton (`CardSkeleton`) with a static fill.

## 4. Accessibility

- Text meets WCAG AA: 4.5:1 for body copy and 3:1 for large text and UI boundaries.
- Never use colour alone to convey state — every `Badge`/status usage pairs colour with an icon or label.
- Every interactive element is reachable and operable by keyboard; focus is visible (`focus:ring-2 focus:ring-vx-primary/15` on inputs/selects, a visible ring on buttons).
- Icon-only controls carry an `aria-label`.
- Modal/`ConfirmModal` roots declare dialog semantics (`role="dialog"`, `aria-modal`) and expose a labelled close control; Escape closes them.
- Form fields are labelled; errors are associated with their field via `Input`/`Select`'s `error` prop.

## 5. Voice & tone

- UI text is Vietnamese (per `CLAUDE.md`); code, comments, and this document are English.
- Prose is sentence case — Vuexy drops the old uppercase-eyebrow convention everywhere except the customer area's own `// Title` pattern (§8, unaffected by this change).
- Numbers are raw and unrounded: money is integer nano-USD, shown with its unit once.
- Errors name the object, the failure, and the next action. Empty states describe what will appear and offer the one action that fills it.
- A known, pre-existing gap (not introduced by this reskin, out of scope to fix here): a handful of `ConfirmModal` call sites and the shared `Modal`'s own default prop values still carry English copy (`"Confirm"`, `"Cancel"`, a few page-specific titles). Fixing this is a content pass, independent of the visual reskin — track it separately.

## 6. Layout & responsive

- Persistent sidebar is `--vx-menu-width` (16.25rem) on desktop, collapsing to `--vx-menu-collapsed-width` (4.375rem) or an off-canvas panel on small screens.
- Header is a sticky `--vx-navbar-height` (3.5rem) bar.
- Tables scroll horizontally rather than compress below their readable minimum (`Table`'s wrapper is `overflow-x-auto`).
- Density is consistent: 40px control rhythm, Card's default padding, consistent section gaps across pages built from the same primitives.

## 7. Anti-patterns

- Gradients on surfaces, buttons, or icons (still banned — elevation comes from shadow, not a gradient fill).
- Blurred colour blobs, glow pulses, and animated backgrounds.
- Fake desktop chrome — traffic-light dots, window frames, title bars.
- Emoji used as icons or as status markers — use `Badge`/`icon` instead.
- Colour-only status signalling.
- Hand-rolled markup that reimplements a primitive (a raw `<table>`, a raw modal overlay, an ad-hoc badge span) on any page that already imports the shared components — if a primitive is missing a prop a page genuinely needs, extend it additively; don't revert to hand-rolled markup.
- A second, competing visual system introduced ad hoc on one page — if something doesn't fit an existing primitive, that's a signal to add a primitive (§2's "what still carries the old neutral tokens" list), not to invent a one-off look.

## 8. Customer area (`/account/*`, `/login`, `/register`)

Unaffected by the admin dashboard's Vuexy reskin — a separate, intentionally distinct system. Primitives live in `src/app/account/components/ui.js`.

The customer area follows the "studio" pattern of developer tools (reference: Command Code's studio): quiet, sentence-case chrome, mono only for headings and data, square corners, hairline borders, no shadows. It does not use any `vx-*` token or `src/shared/components/*` primitive described above.

- **Frame** — 256px sidebar, 64px sticky header carrying the current page (icon + name) on the left and email, square initial and sign-out on the right. Below `lg` the sidebar becomes a row of tabs under the header.
- **Navigation** is sentence case, sans 14px/500, with an outline icon; the active item is a `surface-2` fill, no side bar.
- **Headings** are `// Title`: mono, 24px page / 16px section, with a muted `//` prefix. One per page, then one per section.
- **Sections** are two columns at `lg`: heading + one muted paragraph on the left (280px), content on the right. One column below.
- **Panels** are bordered surfaces with a 5px square at each corner. No shadow, no fill other than `surface`.
- **Figures** — the number is the loudest element: sans 36px/600, its unit in muted mono beside it, its label as an 11px mono eyebrow above.
- **Primary action** is solid `text-main` on `bg` (black in light, white in dark), mono 13px, sentence case.
- **Tags** are square, mono 11px uppercase, always carry a text label.
- **List rows** are `surface-2` fills with a 1px border; identity in mono, detail in muted sans, actions at the right edge.
- **Steps** are numbered `[01]` only where order is real (setup instructions); code is shown in a `$` box with a copy control and an accessible label.
- Empty states use a dashed border and one action.

---

UI/UX work on `/dashboard/**` must read §1-7 of this document before any visual change; work on `/account/**` must read §8 instead.
