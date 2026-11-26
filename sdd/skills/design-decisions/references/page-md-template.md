# Page decision file template

Used by Step 6 of the `design-decisions` skill for every Layer 2 scope: one locked file per screen or screen type at `design/pages/<slug>.md`. `DESIGN.md` keeps only the index that links these files. Write and lock page files only through the skill or an approved `ui-prompt` exit review.

## Rules

- `<slug>`: lowercase ASCII kebab-case of the scope (normalize non-ASCII letters to their ASCII equivalents before slugging), stable once created. Reuse the slug of an existing file for the same scope; on a collision add `-2`, `-3`.
- A file covers exactly one `scope` (a screen or a screen type). Pattern files list every screen they cover under "Screens covered".
- Take choices, values, rejected alternatives and notes from the `check` output. `OTHER` answers have no `vars`: derive the values from the description.
- "Overrides" is the only place where a page file may deviate from `DESIGN.md`; list each deviation explicitly. Otherwise write "None."
- `status: locked`, `layer: 2`. Bump `version` and add a changelog row whenever the file changes.
- Don't write Layer 2 decisions back into `DESIGN.md`; only its index row changes.

````markdown
---
project: <name>
scope: <screen | screen type>
pages: [<screen or route>, ...]
status: locked
version: 1
updated: YYYY-MM-DD
layer: 2
---

# <scope name>

> Locked. Part of the project's UI/UX decisions; for the screens above it overrides `DESIGN.md`.
> To change anything, invoke the `design-decisions` skill, or approve the delta in a `ui-prompt` exit review.

## Screens covered
- <screen or route> — <short note>

## Decisions — Layer 2

### D12 — <title>  [scope: <screen | screen type>]
- **Choice:** <ID> — <name>: <description>
- **Values:** <hex / font / px / rule>
- **Rejected:** <ID name>, <ID name>, ...
- **User note:** <verbatim, if any>

## Overrides
<!-- Only deliberate deviations from DESIGN.md. Otherwise "None." -->
| Layer 1 | DESIGN.md | Here |
|---------|-----------|------|
| <token or rule> | <value> | <value> |

## Changelog
| Version | Date | Change |
|---------|------|--------|
| 1 | YYYY-MM-DD | Initial lock |
````
