# Design deltas

## Scope gate

This workflow applies only when `DESIGN.md` exists and is `status: locked`. Without that baseline, the session continues without design-delta governance: no delta is recorded, the review does not run, no delta or design file is written, and `DESIGN.md` is never created. Read project instructions and any design docs as context, but do not treat them as locked. Report the skipped review at exit.

A session with a locked design can legitimately change something `DESIGN.md` locks. The change is not blocked and it does not open a second `design-decisions` job: it is recorded as a **delta** during the session and ratified at exit. This file defines the record, the review, and the only write path into the design files.

## When a delta exists

Read the locked decisions before classifying. A change is a delta when it:

- gives a covered decision a new value (color, typography, spacing, shape, elevation, component style, layout);
- introduces a style rule no decision covers;
- creates or changes a scope with no Layer 2 decision;
- removes a locked behavior.

No delta: a bug fix, a copy change, a data or behavior change inside the decision, or an implementation detail with the same visual result.

Ambiguous classification is a stop-and-ask, not a delta. Never invent a decision.

## Record during the session

Keep the record in the session log; do not write project files. One entry per distinct change:

```json
{
  "id": "D02",
  "scope": "global",
  "layer": 1,
  "kind": "changed",
  "title": "Brand accent",
  "from": "green-700",
  "to": "green-600",
  "files": ["src/theme.js"],
  "element": "Save button",
  "prompt": "make the primary action lighter",
  "evidence": "computed backgroundColor rgb(22,163,74)"
}
```

`id` is the locked decision ID or `"new"` when no decision exists. `kind` is `added`, `changed`, or `removed`. A later change that reverts an earlier one cancels both entries. Multiple changes to one decision collapse into one entry with the first `from` and the final `to`.

Call `window.__uiPromptPicker.notify("D02 affected — reviewed at exit")` and continue. The record stays private until the exit review approves it.

## Exit review

1. Re-read `DESIGN.md` and every `design/pages/*.md`; the user may have changed them during the session. Drop a delta already covered by the current design.
2. Consolidate duplicates and reverts. Run the final drift scan on the changed files: ad-hoc hex colors, font overrides, non-token radii/shadows/spacing.
3. No deltas → skip the review.
4. Page alive → `window.__uiPromptPicker.reviewDeltas(deltas)`; page gone → present the same list in chat.
5. The review is per item and nothing is preselected. `approved` and `rejected` come back as delta objects; `cancelled: true` means reject all. Approval is the only authorization to touch design files.

## Write approved deltas

Keep the diff limited to the approved decisions.

- **New decision** — allocate the next free `Dxx`; append it to the right layer. Never renumber existing decisions.
- **Layer 1** — update `Choice`, `Values`, and `User note`; append the old option to `Rejected` instead of deleting it. If a token changed, update the Tokens block in the same edit.
- **Layer 2 inline** — update the matching decision in `DESIGN.md`. Only create `design/pages/<slug>.md` when the project already uses page files; follow `<skill-dir>/../design-decisions/references/page-md-template.md`.
- **Page files** — update the scope's file, bump its `version`, add its changelog row; add a `DESIGN.md` changelog row naming the page. Do not copy Layer 2 decisions back into `DESIGN.md`.
- **Tokens** — the Tokens block is canonical; sync the project's token implementation (theme file, CSS variables) to it. No ad-hoc values.
- **Version** — one bump per approved batch: `version`, `updated`, and one changelog row (`| 3 | 2026-11-25 | D02: green-700 → green-600; D05 added (ui-prompt approved) |`). Keep `status: locked`.
- Do not rewrite unrelated decisions or remove changelog history.

## Delta file

The `design-decisions` delta schema is canonical: `<skill-dir>/../design-decisions/references/delta-schema.md`. Emit one file per layer:

- `design/deltas/delta-ui-prompt-<YYYYMMDD-HHmm>.json` (create the directory if needed);
- `round`: `ui-prompt-<YYYYMMDD-HHmm>`, plus `-k1` / `-k2` for a mixed batch;
- `version_from` / `version_to`: the DESIGN.md versions around the batch;
- `design_files`: files written by that layer's batch;
- `scopes[].changes[]`: `id`, `kind`, `title`, `from`, `to`, `note: "approved via ui-prompt exit review"`;
- map string values to the schema's objects: `{"choice": "...", "name": "...", "values": "..."}` or `{"choice": "OTHER", "desc": "..."}`;
- `to_fingerprint`: omit. It comes from `check`, which this skill does not run; say so in the report. `apply-design` then falls back to version comparison (`<skill-dir>/../apply-design/references/applied-ledger.md`).

## Ledger

Do not write `design/applied.md`; `apply-design` owns it. The delta file is the handoff. If the user wants the ledger synced, run `/apply-design`; it verifies before recording.

## Rejected deltas

Leave the design files unchanged. Keep the code, list the item as **unresolved design drift** with files and lines, and offer a revert. Never revert silently; if the user asks, use the project's git workflow and re-verify afterwards.

## Governance

An approved exit review is a sanctioned design write, equivalent to a locked `design-decisions` round. A UI submission authorizes the code change; it does not authorize a design-file write—only the approved review does. `design-decisions`, `apply-design`, and the design templates allow this path.

## Never

- Run this workflow without a locked `DESIGN.md`.
- Create or initialize `DESIGN.md`; this skill applies existing decisions, it does not establish them.
- Write a design file without an approved review.
- Fabricate a decision, a version, or a fingerprint.
- Delete `Rejected` options or changelog rows.
- Touch production or a design file you did not re-read at exit.
