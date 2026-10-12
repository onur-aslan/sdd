---
name: sdd-review
description: Single post-implementation review. Checks the diff against the requirements (Missing / Extra / Incorrect) and finds design-level slop in the new code. Invoke ONLY when the `sdd-review` skill is explicitly named — by the user (e.g. /sdd-review) or by another skill/prompt instructing to invoke sdd-review by name. Never select this skill by matching a task description to it.
---

# Review

One review, two questions:

1. **Spec pass** — did the implementation do the *right thing*? (requirements vs. code)
2. **Slop pass** — did it do it *well*? (reuse, proportion, local fit, unhandled failures, untrustworthy tests)

---

## Step 1 — Inputs

Defaults when the user gives no argument:

- **Requirement** → `spec.md` (locate it in the project)
- **Scope** → `diff` (git diff, staged + unstaged)

Ask only when a default cannot be used: no `spec.md` can be found (ask for the requirement file, or use the spec from the current conversation if there is one), or the diff is empty (ask for another scope).

The user may name another requirement file, or another scope: `pr` / `mr` (branch against its base), `A..B` (commit range), a file or directory path, `full`, or `fix` / `apply` (go to Fix Mode).

Write a one-line scope descriptor and reuse it everywhere, e.g. `scope: branch feature/auth → main — git diff abc1234..HEAD`.

Read the requirement fully before looking at code. For diff scopes read the diff once and use it for both passes; for a path or `full` scope read the files in scope.

---

## Step 2 — Run Both Passes

Small scope (a few files): run both passes yourself.
Larger scope: run two general-purpose agents in parallel (Spec, Slop) with the same scope descriptor and requirement. Each returns its findings; you write the report. Do not use agents to verify or double-check findings.

### Pass A — Spec

Map every requirement item (acceptance criterion, Gherkin scenario, user story) to the code in scope and classify it:

- **Missing** — required behaviour that is absent, including behaviour that is only stubbed or faked (a hardcoded or trivial result that satisfies the tests but not the requirement)
- **Incorrect** — implemented, but behaviour differs from the requirement
- **Extra** — not asked for:
  - unrequested features or steps (docs, config, new dependencies, unrelated cleanup or refactors)
  - existing content, settings or behaviour that the requirement did not touch but the change overwrote or reverted
  - **residual edits**: hunks that serve no requirement and could be reverted without changing behaviour or test results (speculative changes, abandoned attempts, temporary code)
  - Code a requirement needs (wiring, migrations, tests) is not Extra.
- **Covered** — implemented and matches

Rules: cite the requirement ID or heading and the `file:line` that implements it. A requirement with no matching test is a finding only if the requirement asks for tests. Judge conformance only, not code quality. Every Missing / Incorrect / Extra finding carries a one-line **fix** in the form `file(:line) → concrete change`: it names the file(s) to create or edit and what changes in each (e.g. `auth.service.ts:42 → add the missing role check per AC-3`; `new-utils.ts:1-20 → delete, superseded by the fix above`). A fix naming no file is incomplete.

### Pass B — Slop

The code in scope is the review target. Read the surrounding codebase for comparison: reuse, duplication and local conventions can only be judged against what already exists. Every pattern below needs judgement about the requirement or the surrounding code.

Report every finding you can support; severity and confidence carry the filtering, not silence. Each finding has:

- the pattern ID (e.g. `B1.1`) and `file:line`
- the concrete impact
- **evidence**: what you checked in the code (the helper you searched for, the guard you looked for), not your reasoning
- **fix**: the one-line concrete action that resolves it, in the form `file(:line) → concrete change` — the file to edit and what changes there (e.g. `orders.service.ts:88 → replace local formatDate with utils/date.ts:formatDate and delete the local copy`, `batch.ts:12-30 → wrap the loop body in try/finally so temp files are cleaned on failure`). A fix naming no file is incomplete.
- **confidence**: High / Medium / Low

**B1 — Reuse & proportion**
- **B1.1 Re-invented utility**: for every new helper, function or module in scope, search the codebase for an equivalent. Flag it if one exists.
- **B1.2 Semantic duplication**: the same behaviour implemented in several places with different structure or naming
- **B1.3 Disproportion**: far more code, tests, layers or tiny single-use helpers than this requirement justifies

**B2 — Local fit**
- **B2.1 Inconsistency**: a different pattern than the codebase uses for the same concern (DB access, validation, error responses, logging); some functions throw while others return null for the same kind of failure; names or terminology that diverge from existing code or the project glossary

**B3 — Unhappy paths & masked failures**
- **B3.1 Mishandled edge input**: input the requirement implies (zero, empty, boundary, missing) that the new logic gets wrong
- **B3.2 Partial failure**: one failing item drops or corrupts the results of the others; missing cleanup or rollback
- **B3.3 Masked failure**: a failure turned into a value the caller cannot tell apart from success

**B4 — Silently ignored settings** (the build passes, the setting does nothing)
- **B4.1 Option keys, config keys, env var names, CLI flags** in new code that the installed library or tool version does not recognise. Unknown keys are often ignored without an error, so confirm each against the installed version.

**B5 — Test trustworthiness**
- **B5.1 CI / test weakening** (hard stop): tests removed, renamed or skipped; assertions loosened (exact value → truthy); snapshots or golden files regenerated without reason; coverage threshold lowered; CI steps made conditional or non-blocking
- **B5.2 Weak oracle**: a test that would still pass if the behaviour it covers were wrong (expected value computed with the code under test, assertions that pin nothing specific)
- **B5.3 Mock overuse**: the unit under test is mocked, or the mock supplies the answer

Do not flag missing tests for private helpers, constructors or getters.

---

## Step 3 — Report

Write `docs/sdd/review/report.md`. Match its length to the findings: no filler sections, redundant summaries or boilerplate.

```markdown
# Review Report
Scope: <scope descriptor>
Requirement: <file or "conversation">

## Summary
Spec: X covered · Y missing · Z incorrect · W extra
Slop: 🔴 a · 🟠 b · 🟡 c

## Spec Findings
| # | Sev | Type | Requirement | Location | Note | Fix |
|---|-----|------|-------------|----------|------|-----|

## Slop Findings
| # | Sev | ID | Location | Impact | Evidence | Fix | Conf |
|---|-----|----|----------|--------|----------|-----|------|
```

Every finding row carries a `Fix` in the form `file(:line) → concrete change`: the reader sees which file to touch and what changes there — never "fix this" or a restatement of the finding. Severity reflects impact; confidence is reported separately.

| Finding | Bucket |
|---|---|
| Missing, Incorrect | 🔴 Critical |
| B5.1 CI / test weakening | 🔴 Critical |
| Extra (including residual edits) | 🟠 Important |
| B1.1, B1.2, B1.3 | 🟠 Important |
| B2.1 | 🟠 Important |
| B3.1, B3.2, B3.3 | 🟠 Important |
| B4.1 setting that is ignored or could not be verified | 🟠 Important |
| B5.2 | 🟠 Important |
| B5.3 | 🟡 Moderate |

If a section has no findings, say so in one line.

Final reply to the user: the first sentence is the outcome (the Summary counts and whether anything is 🔴), then the 🔴 findings and the top 🟠 — each with its `Fix` so the reader knows what to do — then the report path. Patterns that never fire across several reviews can be deleted from this file.

---

## Fix Mode

Triggered by `fix` / `apply` (argument or after the report).

1. Read `docs/sdd/review/report.md`. If missing, run Steps 1–3 first.
2. Ask which findings to apply (default: findings at High or Medium confidence — 🔴 first, then 🟠). Never touch 🟡 or Low-confidence findings without being asked.
3. Fix Spec findings first (Missing → Incorrect → Extra), then Slop findings.
4. Fix only what the report lists, starting from each finding's `Fix`; deviate only when the code shows a smaller change that resolves it. No adjacent cleanup, renames or refactors.
5. Never weaken, skip or delete a test to make it pass. If a test is wrong, say so and ask.
6. For *Extra*: ask whether to remove it or add it to the requirement.
7. Make one pass. Run the project's tests once, then report what changed and what is left open. Do not start another review loop.
