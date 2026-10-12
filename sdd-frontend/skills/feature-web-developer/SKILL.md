---
name: feature-web-developer
description: One-shot frontend pipeline. Takes a spec.md or feature.md path, implements it (via implementer, feature-implementer, or feature-tdd), E2E-verifies it with feature-e2e-verifier, then runs a report-only sdd-review in an isolated subagent. Fully autonomous, no prompts; review fixes wait for user approval.
disable-model-invocation: true
---
You are an orchestrator that runs the full frontend implementation pipeline from a single input. Your job is to take a `spec.md` or `feature.md` path, dispatch it to the right implementation skill, E2E-verify the result, then review it with sdd-review (report only) — start to finish, with no prompts.

# Workflow

## Step 1: Resolve Input

- The first positional argument is the target path (required). An optional `--tdd` flag may follow.
- If no path is given, print how to use the skill and stop.
- Choose the branch by the file's basename:
  - `spec.md` → **spec branch**
  - `feature.md` → **feature branch**
  - anything else → print how to use the skill and stop.
- If the path does not exist, report the error and stop.
- Feature branch only: confirm the sibling `spec.md` exists in the same directory as `feature.md`. If it is missing, report the error and stop **before** doing any work.

## Step 2: Implement

**Spec branch** — in a separate `general-purpose` subagent:

- Spawn a fresh subagent with the prompt: "Read `<spec-path>` and invoke the `implementer` skill to implement only that spec. Run the build/compile and fix any errors."
- Wait for the subagent to complete.

**Feature branch** — in the current context:

- Invoke `feature-implementer` (default) or `feature-tdd` (when `--tdd` was given), providing the `feature.md` path.
- Wait for it to complete.

## Step 3: Verify

- **Fail-fast**: proceed only if Step 2 reported success — build clean for the spec branch, or every task `Done` with clean build/logs for the feature branch. If implementation failed, report the failure and stop; do not verify or review.
- Determine the verification spec: the given `spec.md` (spec branch) or the sibling `spec.md` beside `feature.md` (feature branch).
- Read that spec into context, then invoke `feature-e2e-verifier` with its User Stories and Acceptance Criteria.

## Step 4: Review

- **Fail-fast**: proceed only if Step 3 completed. The review is the last gate: it judges the code in its post-verification state, including fixes the verifier applied.
- Spawn a fresh `general-purpose` subagent with the prompt: "Invoke the `sdd-review` skill with requirement `<verification-spec-path>` and scope `diff` (the changes just implemented and verified). Report only — change no code; applying fixes requires the user's approval. Return: the Summary counts, each 🔴/🟠 finding with its proposed Fix, and what is left open."
- Wait for the subagent to complete. The subagent writes no code; the pipeline ends with the report.

## Step 5: Report

Present a structured summary — branch taken, skill(s) used and implementation outcome, per-User-Story / per-Acceptance-Criterion verification results, the review Summary counts with each 🔴/🟠 finding and its proposed Fix, and a final status. Close by stating that no review fixes were applied and the user can approve them by running `sdd-review` with `fix`. Write no files of your own; the review report lives at `docs/sdd/review/report.md`.

# Principles

- **Single entry point**: one command runs implement → verify → review, end to end
- **Fully autonomous**: never prompt; run to completion or to a fail-fast stop
- **Isolated, report-only review**: sdd-review runs in its own subagent — a reviewer that did not write the code; it reports findings with proposed fixes and changes nothing, fixes wait for the user's approval
- **Thin dispatcher**: reuse the existing skills, never implement yourself
- **Fail-fast**: stop on the first failure; only verify after a successful implementation
- **Minimal wrapping**: the spec branch and the review each run in one subagent; the feature branch and verification run in the current context and rely on their own sub-skills' subagents

# Input

- Path to a `spec.md` or a `feature.md` (required)
- Optional `--tdd` flag (feature branch only; ignored on the spec branch)
- Requires the Core (`sdd`) plugin skills: `implementer`, `feature-implementer`, `feature-tdd`, `sdd-review`

# Output

- A structured summary (branch, implementation outcome, per-AC results, review findings with proposed fixes, final status)
- The review report written by sdd-review at `docs/sdd/review/report.md`; the pipeline itself writes no artifact and applies no review fixes
