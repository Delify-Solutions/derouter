## Context

Supersedes the phone part of account-settings D4 (header hamburger + top glass
panel). The glass tokens (`.liquid-glass`, `.liquid-glass-item`, reduced
transparency/motion fallbacks) are reused.

## Decisions

### D1. Four tabs plus "Thêm"
The tabs are the pages a customer opens most: overview, plans, gifts and
notifications (which carries the unread count). Every other page, the channel link
and sign-out are under "Thêm". "Thêm" is marked current when the open page is one
of its pages, so the current page is always marked in the bar (fill icon, weight,
pill — never colour alone).

### D2. Floating capsule, denser glass
The bar floats 12px above the bottom (plus the safe-area inset), radius 28px, each
tab a 56px-high pill. Page text scrolls under it, so its fill is 0.84 opaque
(light and dark) to keep labels AA; reduced transparency makes it opaque.

### D3. The sheet keeps the dialog contract
Modal, rendered into `<body>` at z-50, page behind inert, focus trapped, closes on
item / Escape / outside tap / route change, focus returns to "Thêm". It rises from
the bar (`liquid-glass-enter-up`), no animation under reduced motion.

### D4. Archive order
`account-settings`, `models-notifications` and this change each replace the whole
"Navigation and language" requirement. This delta carries the full current text
(including Model, Thông báo and Kênh Telegram), so it must be archived last.

### D5. Order pages and quota mark "Gói"
They are reached from the plans page, so the bar marks `Gói` there.

### D6. Content clearance
`main` gets `pb-[calc(7rem+env(safe-area-inset-bottom))]` below `lg`.
