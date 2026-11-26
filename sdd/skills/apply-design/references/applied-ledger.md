# applied ledger

`design/applied.md` records what the code implements and what has been verified. `DESIGN.md` and `design/pages/<slug>.md` remain the source of truth for what the design is; the ledger only tracks applied state.

## Template

```md
---
updated: YYYY-MM-DD
---

# Applied design

| Scope | Decision | Source | Version | Fingerprint | State | Applied | Verified | Base |
|---|---|---|---|---|---|---|---|---|
| global | D01 | DESIGN.md | 2 | sha256:… | active | 2026-11-24 | pass | abc1234 |
```

No other prose is needed. Keep rows sorted by scope, then decision ID.

## Columns

| Column | Meaning |
|---|---|
| Scope | `global` or the page-file slug (`chat`, `settings`, …) |
| Decision | Decision ID (`D01`) |
| Source | `DESIGN.md` or `design/pages/<slug>.md` |
| Version | `DESIGN.md` version (or the page file's version) at apply time |
| Fingerprint | `to_fingerprint` from the delta; the exact applied choice |
| State | `active` or `removed` |
| Applied | Date the fingerprint was first applied |
| Verified | `pass`, `skipped`, or `fail` |
| Base | Short commit (`git rev-parse --short HEAD`) before the edits |

## When a decision is pending

| Situation | Pending? |
|---|---|
| No row | yes — bootstrap |
| Row fingerprint differs from `to_fingerprint` | yes |
| Row `Verified: fail` | yes — regression |
| Delta says `kind: "removed"` and row is `active` | yes — remove it |
| `to_fingerprint` absent and delta `version_to` > ledger `Version` | yes |
| `to_fingerprint` absent and versions are equal | ask — don't guess |
| Row `pass` and fingerprint matches | no |
| Row `skipped` and fingerprint matches | no, but verification debt remains |

`--force` makes every decision in scope pending regardless of the table.

## Writing rules

- Update only rows for decisions in the approved scope. Never rewrite unrelated rows.
- Write or update a row only after verification passes (`pass`) or is explicitly skipped (`skipped`). On failure, leave the previous row unchanged and report; the old fingerprint keeps it pending.
- `Verified: fail` is allowed only for an already-applied fingerprint that regressed during verification. The next run treats it as pending.
- `Applied` is the first successful application date of that fingerprint; re-applying the same fingerprint keeps the date.
- `Version` is the design version that was applied; update it when the fingerprint changes, and keep it for `skipped` rows too.
- For a removal, set `State: removed` and `Verified: pass` after confirming the behavior is gone; keep the fingerprint and version for history. Don't delete the row.
- `Base` is the commit before the edits. If the working tree was dirty, say so in the report; don't invent a commit.
- Update the `updated:` date at the top whenever the table changes.
- If no fingerprint is available (a manual `design-decisions` round without `check`, or a bootstrap), write `unknown` and treat the decision as pending on every run until a delta supplies one. Never fabricate a hash.

## Bootstrapping

When `design/applied.md` does not exist, every decision in the selected scope is pending. Create the `design/` directory and the file only after the first verified application; before that, report the planned rows and keep the change out of the diff.
