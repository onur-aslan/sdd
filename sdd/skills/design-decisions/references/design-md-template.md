# DESIGN.md template

Used by Step 6 of the `design-decisions` skill. Copy the template below into `DESIGN.md` at the project root and fill every field from the user's confirmed choices and the scan. Don't invent values or rationale. Keep only the sections that apply (e.g. leave Layer 2 as "Not decided yet" until that round is locked). Layer 2 decisions are written to `design/pages/<slug>.md` with `page-md-template.md`; this file only links them.

````markdown
---
project: <name>
status: locked          # draft | locked
version: 1
locked_at: YYYY-MM-DD
updated: YYYY-MM-DD
layers: [1]             # locked rounds: [1] or [1, 2]
---

# DESIGN.md

> Locked. Agents read and apply this file; they don't edit it by hand.
> Layer 2 lives in the linked `design/pages/` files; for their screens they override this file.
> To change anything, invoke the `design-decisions` skill, or approve the delta in a `ui-prompt` exit review.

## Current state (scan summary)
- Stack: ...
- Existing design traces: ...
- Scope: ...

## Fixed baseline
Text contrast ≥ 4.5:1 · touch targets ≥ 44px · visible focus · reduced-motion support

## Decisions — Layer 1 (global)

### D01 — <title>  [scope: global]
- **Choice:** <ID> — <name>: <description>
- **Values:** <hex / font / px / rule>
- **Rejected:** <ID name>, <ID name>, ...
- **User note:** <verbatim, if any>

## Decisions — Layer 2 (screens and flows)
<!-- Index only. The decisions live in the linked page files (references/page-md-template.md).
     "Not decided yet" until Layer 2 is locked. One row per scope; keep it current. -->

| Scope | Pages | File | Decisions | Version |
|-------|-------|------|-----------|---------|
| <screen or screen type> | <screens/routes> | [design/pages/<slug>.md](design/pages/<slug>.md) | D12–D15 | 1 |

## Tokens
<!-- Take these from the `tokens` field of the `check` output. Keep these exact names: previews and Layer 2 read them. Add more variables if a decision needs them. -->
```css
:root {
  --bg: ...;
  --surface: ...;
  --text: ...;
  --muted: ...;
  --primary: ...;
  --on-primary: ...;
  --accent: ...;
  --border: ...;
  --radius: ...;
  --space: ...;
  --shadow: ...;
  --font-heading: ...;
  --font-body: ...;
}
```

## Changelog
| Version | Date | Change |
|---------|------|--------|
| 1 | YYYY-MM-DD | Initial lock |
````
