---
name: apply-design
description: Applies locked UI/UX decisions from DESIGN.md and design/pages/<slug>.md to the project code, consuming design/deltas/ and maintaining design/applied.md, then verifies the result in the browser with Playwright. Use after a design-decisions round changes a locked decision or when existing code has drifted from the design. Never edits design files.
argument-hint: "[scope|all] [--dry-run] [--no-verify] [--force]"
disable-model-invocation: true
---

# apply-design

The code follows the design, not the other way around. This skill takes locked decisions from `DESIGN.md` and `design/pages/<slug>.md`, discovers where they live in the project code, applies the pending ones, verifies the result in the browser, and records what was applied in `design/applied.md`. It never decides design: a missing or ambiguous decision is a stop-and-ask.

The project is rediscovered on every run. Never rely on a persisted code map or on assumptions from an earlier run; the code is the map.

## Input

`/apply-design [scope|all] [--dry-run] [--no-verify] [--force]`

- `scope` — page slug (`chat`, `settings`, …) or screen name. Applies only that scope's pending decisions.
- `all` — every pending decision across scopes.
- no argument — use `all` when one scope is pending; if several, list them and ask which.
- `--dry-run` — stop after the plan; no files change.
- `--no-verify` — skip the browser step; record `skipped`.
- `--force` — re-apply even when fingerprints match (use after unrelated code drift).

## Step 0 — Preconditions and authority

1. Read `DESIGN.md`. If it is missing, `status` is not `locked`, or `layers` doesn't include 1, stop and tell the user to run `/design-decisions` first.
2. Read every page file linked from the Layer 2 index. If Layer 2 is still inline (no `design/pages/`), it is valid; note that page files haven't been split yet.
3. Read the project's own instructions: `CLAUDE.md`, `AGENTS.md`, `README`, and any `docs/` rules they point to. They override this skill's generic defaults.
4. Scan for competing design authorities: `MASTER.md`, `STYLEGUIDE.md`, `design-system/*`, or any document claiming binding UI rules. Compare them with `DESIGN.md`:
   - no overlap with the decisions being applied → proceed, note it.
   - overlap or contradiction → **stop before editing**. List the conflicts and propose one of: merge the unique rules through `/design-decisions`, then replace the file with a pointer to `DESIGN.md`, or retire it. Never edit or delete it yourself; never let two files bind the same decision.
5. `git status --short`: note unrelated changes so the report can separate them. Don't stash or revert anything.

## Step 1 — Read the delta and the ledger

- Read `design/applied.md`; missing means nothing has been applied yet (`references/applied-ledger.md`).
- Read `design/deltas/*.json`; a missing directory means there are no delta files. If several deltas touch one decision, the newest `created_at` wins.
- Pending decisions:
  - no ledger row → pending (bootstrap).
  - `kind: "removed"` → pending removal.
  - ledger `Fingerprint` differs from `to_fingerprint` → pending.
  - `to_fingerprint` absent (manual round) → compare `version_to` with the ledger's `Version`; if still ambiguous, ask.
  - `--force` → every decision in scope.
- No delta files: derive pending by comparing locked values with the ledger; never blindly re-apply everything.
- The delta is a change log; `DESIGN.md` and page files are canonical. If they disagree, follow the locked file, report the mismatch, and ask the user to regenerate the delta through `/design-decisions` — don't edit it.
- Report a table (Decision, Scope, Change, Title, Source). If nothing is pending, say so and stop.

## Step 2 — Discover the code and plan

- Read `references/discovery.md` and follow it **now**, every run. Do not read or trust a cached or persisted code map; if the repository has one, treat it as a stale hint at most.
- Locate the exact file, symbol, and token for each pending decision with `Glob`, `Grep`, and `Read`.
- For a large or unfamiliar repository, parallel read-only `Explore` subagents may cover independent areas (theme, shell, screens, data). Never run parallel editing subagents.
- Also collect the commands and inputs needed later: install/build/test/lint, dev server command/port/protocol, backend or proxy, login flow, test roles/accounts (names only), and the viewports the UI supports.
- Write the plan as a table: decision → files → concrete change → verification assertion. Include the order and the commands to run.
- Anything the design doesn't cover, or a change that would require a new decision: stop and ask for `/design-decisions`; don't invent.
- Wait for explicit approval. `--dry-run` ends here.

## Step 3 — Apply

- One writer. Read-only `Explore` subagents may map files; never run parallel editing subagents.
- Order: tokens/theme → app shell/navigation → shared components → screens. This keeps later checks on a settled base.
- Follow the project rules and conventions discovered in Step 2: colors/fonts/shape through the theme or token layer; HTTP through the project's API client; data through its hooks/data layer; roles/nav/status through config files; reuse existing UI primitives; use the existing server-side filter infrastructure when adding search/filter UI.
- Smallest diff that satisfies the decision. No drive-by refactors, no new dependencies, no design edits.
- If the approved plan no longer fits the code, stop and re-plan.

## Step 4 — Static checks

- Run the build, test, and lint commands discovered in Step 2 (package scripts, Makefile, task runner, etc.) in the project's documented order.
- Report the exact failure output. A failing build blocks Step 5; don't verify a broken build.

## Step 5 — Verify in the browser

- Follow `references/verification.md`: start the dev server with the discovered command/port, log in through the UI, and navigate the way the app actually works (click; don't deep-link into state-based views).
- Cover the scope's decisions in both themes when the decision is theme-sensitive, and at desktop plus mobile widths when layout/responsive.
- Save screenshots under `.design/verify/<YYYYMMDD-HHmm>-<scope>/`. They must be gitignored before they are written; if the directory is not ignored, ask to add it to `.gitignore` first.
- Pass means every decision in scope has a passing assertion, no new console errors, and no visible clipping/overlap in the screenshots. Don't call a failure a pass because the screenshot "looks fine".
- If Playwright, the dev server, the backend, or the accounts are unavailable, stop and ask; use `--no-verify` only with the user's agreement.

## Step 6 — Record and report

- Update `design/applied.md` exactly as `references/applied-ledger.md` says: only decisions with a verified pass get the new fingerprint and version; `--no-verify` records `skipped`; failures leave the old row.
- Report: decisions applied, files changed, build/test/lint results, verification assertions and screenshots, still-pending decisions, competing-source proposal, and follow-ups.
- Never commit. Offer the project's own commit workflow if it has one.

## Hard rules

- `DESIGN.md`, `design/pages/`, and `design/deltas/` are read-only here. Only `design-decisions` or an approved `ui-prompt` exit review changes them.
- Never edit or delete competing design documents or project instruction files; propose only.
- Never delete files or bypass verification to make a check pass.
- No secrets, tokens, or real user data in screenshots, reports, or commit messages.
- A decision the design doesn't cover is a question, not a guess.
- Rediscover before every run; a stale assumption is worse than a missing one.
