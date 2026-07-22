---
name: code-slop-review
disable-model-invocation: true
---

# Code Slop Review

Code slop is code that compiles, passes tests, and quietly rots the codebase.
It looks polished — consistent naming, green CI, clean PR description — while
silently eroding architectural coherence.

---

## Step 1 — Select Scan Scope

**Accepted argument formats — if the user provides any of these, use it directly:**
```
1  or  "full"                        → full codebase
2  or  "diff"                        → git diff (uncommitted changes)
3  or  "mr"  or  "pr"               → merge / pull request
4  or  "commits"  or  "A..B"        → commit range
A file path (e.g. src/auth.ts)      → single file scope
A directory path (e.g. src/)        → single directory scope
"fix"  or  "refactor"  or  "apply"  → skip to Fix Mode directly
```

**If no recognizable argument is given, ask exactly this before doing anything else:**

> What should I scan?
> 1. **Full codebase** — all source files in the project
> 2. **Git diff** — uncommitted changes (staged + unstaged)
> 3. **Merge / Pull Request** — changes introduced by a branch against its base
> 4. **Commit range** — changes between two specific commits

Wait for the user's answer. Do not start scanning until a scope is chosen.

**After scope is determined, produce a scope descriptor** — a concise string
that the explore agents will use to know what to scan. Examples:

```
scope: full codebase — all source files under ./src
scope: git diff HEAD — uncommitted changes
scope: MR diff — branch feature/auth → main (merge base: abc1234) — run: git diff abc1234..HEAD
scope: commits a1b2c3..d4e5f6 — run: git diff a1b2c3..d4e5f6
scope: single file — src/auth/login.ts
scope: directory — src/payments/
```

---

## Step 2 — Prepare Output Directory

Create the output directory if it does not exist:

```bash
mkdir -p docs/sdd/code-slop
```

Determine which layers apply based on scope:

| Layer | Full | Diff (2/3/4) | Single file | Single dir |
|-------|------|--------------|-------------|------------|
| 1 — Structural | ✓ | ✓ | ✓ | ✓ |
| 2 — Tests | ✓ | ✓ | if test file found alongside source | ✓ |
| 3 — Error Handling | ✓ | ✓ | ✓ | ✓ |
| 4 — Architecture | ✓ | ✓ | ✗ | ✗ |
| 5 — Dead Code | ✓ | ✓ | ✓ | ✓ |

---

## Step 3 — Run Analysis

**For non-full-codebase scopes (diff, single file, directory):**

Skip explore agents. Use a single Explore task to scan for all slop types at once.

→ Read [references/agent-prompt.md](references/agent-prompt.md) and use the "For Non-Full-Codebase Scope" prompt.

Replace `<scope descriptor>` with the actual scope from Step 1 and launch the task.

Write output to: `docs/sdd/code-slop/diff-review.md`

**For full codebase scope:**

Spawn one explore agent per applicable layer. All agents run against the
**same scope descriptor from Step 1**. Launch all applicable agents in parallel —
do not wait for one to finish before starting the next.

→ Read [references/agent-prompt.md](references/agent-prompt.md) to get the prompt template.

For each applicable agent below, fill the template placeholders and launch:

| Agent | Layer Name | `<layer-reference-file>` | `<output-filename>` | Skip if |
|---|---|---|---|---|
| 1 | Structural Slop | `structural-slop.md` | `layer-1-structural.md` | — |
| 2 | Test Slop | `test-slop.md` | `layer-2-tests.md` | Layer 2 not applicable per Step 2. For single-file scope: check if a test file exists alongside the source before spawning. |
| 3 | Error Handling Slop | `error-handling-slop.md` | `layer-3-error-handling.md` | — |
| 4 | Architecture Slop | `architecture-slop.md` | `layer-4-architecture.md` | Layer 4 not applicable per Step 2 |
| 5 | Dead Code Slop | `dead-code-slop.md` | `layer-5-dead-code.md` | — |

Wait for all agents to complete before proceeding to Step 4.
Step 4 starts after all Task tool calls have returned — not before.

---

## Step 4 — Aggregate and Produce Final Report

**For non-full-codebase scopes:**
Read `docs/sdd/code-slop/diff-review.md` and display the results to the user.
Skip aggregation — the single agent already produced the final report.

**For full codebase scope:**
→ Read [references/aggregate-and-report.md](references/aggregate-and-report.md) and follow its steps.

---

## Fix Mode

Triggered when the user says "fix", "refactor", or "apply" — either as an
initial argument (Step 1) or after the report is produced.

- If `docs/sdd/code-slop/report.md` exists (full codebase scan): read it and → Read [references/fix-mode.md](references/fix-mode.md).
- If `docs/sdd/code-slop/diff-review.md` exists (diff/file/dir scan): read it and → Read [references/fix-mode.md](references/fix-mode.md).
- If no report exists yet: run Steps 1–4 first to produce one, then enter Fix Mode.

---

## Out of Scope

- Security vulnerability scanning — requires a dedicated audit
- Performance profiling — requires benchmark tooling
- Business logic correctness — requires domain knowledge
- Syntax errors — handled by linters and compilers
