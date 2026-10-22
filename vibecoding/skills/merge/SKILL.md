---
name: merge
description: Merge a branch into a reviewable integration branch off the target — merge directly when nothing diverged, and when commits landed in between, dry-run the merge, auto-resolve the riskless conflicts, decide the risky ones with the user one at a time, then build the approved merge on the branch. The target is left untouched for review.
argument-hint: "<source-branch> [target-branch] [--lang <language>]"
disable-model-invocation: true
---

# merge

Merges the **source** branch from `$ARGUMENTS` with the **target** branch into a reviewable integration branch, reconciling conflicts on the way, and leaves the target branch itself untouched.

## Input

- **source** (required): the branch merged in, e.g. `feature/login`.
- **target** (optional): the branch merged into; default is the current branch.
- **language** (optional, `--lang <language>`): the language the session runs in — the plan table, the questions and the reports; default is the language the user writes in.

## Flow

```mermaid
flowchart TD
    A[Resolve source and target refs] --> B{Working tree clean?}
    B -- no --> Z1[Stop: ask the user to commit or stash]
    B -- yes --> C{Target has no commit<br/>the source lacks?}
    C -- yes --> M[Merge the source into a new branch off the target]
    C -- no --> D[Dry-run the merge,<br/>touching the working tree not at all]
    D --> F[Review each conflict and the merged result]
    F --> G{riskless?}
    G -- yes --> H[Resolve directly]
    G -- no --> I[Show options + a recommendation,<br/>wait for the user's choice]
    H --> P[Print every decision as a table, ask approval]
    I --> P
    P --> J{Approved?}
    J -- no --> Z2[Stop: nothing was merged]
    J -- yes --> M
    M -->|fails| Z3[Abort the merge, drop the branch, report]
    M --> K[Report the branch and every resolution]
```

## Rules

**Setup** — Both refs must resolve to branches and the working tree must be clean; otherwise report and stop.

**Branch** — All the merge work goes on `merge/<source>-into-<target>`, branched from the target; the target branch itself is never modified.

**Classify** — every conflict (base / ours / theirs), and the merged result as a whole:
- *Riskless* — resolve it yourself: the sides do not interact, or the change is mechanical.
- *Risky* — the user decides: the sides touch the same behavior or contract, or the merge leaves something broken or inconsistent. Unsure counts as risky.

**Ask when it is the user's call** — one per turn, never batched: base/ours/theirs, then 2-3 options with the one you recommend, then the user's choice. Never decide it for them.

**Plan, then merge** — Show **every** decision — the ones you resolved and the ones the user chose — in a table: *Area / file | Status | Finding | Decision | Risky?* (`Risky?` is yes when the user decided, no when you did). Then wait for approval, and on approval build the merge on the integration branch.

**After** — Report the integration branch and every resolution. Landing it on the target is the user's later step, and a fast-forward one, since the branch descends from the target.

**Limits** — Never push and never touch the target branch; the only commits are the ones the merge itself writes on the integration branch. What the merge breaks is fixed with it, never deferred as a follow-up.
