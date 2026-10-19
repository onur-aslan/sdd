---
name: sdd-developer
description: Implement spec.md through baseline checks, sequential subagents, review and fix, and per-story E2E verification.
argument-hint: "[spec.md] [max_turns] [--no-verify]"
disable-model-invocation: true
---

# Suitable Tools

Use tools as appropriate to each story's acceptance criteria; not every tool is required.

- Playwright MCP
- Python
- curl
- CLI tools
- Tests
- Logs
- Build tools

# Workflow

Parse `$ARGUMENTS`: it may contain a spec path, a number (`max_turns`, the skill-wide budget, default `10`), and/or the flag `--no-verify`, in any order. When `--no-verify` is present, skip the Story Verification phase entirely; everything else runs unchanged. Read the spec — the given path, or `docs/sdd/features/<feature>/spec.md` by default.

```mermaid
flowchart TD
    subgraph MAIN["Main Agent - Orchestration Only"]
        E["Spawn Implementation Subagent"]
        F["Receive implementation result"]
        G["Spawn Review Subagent"]
        H["Receive review result"]
        I["Extract stories in spec.md order"]
        J["Spawn verifier for current story"]
        K["Receive and record story result"]
        L{"More stories?"}
        NV{"--no-verify?"}
        M["Final report"]
    end

    subgraph IMPL["Implementation Subagent"]
        N["Implement spec requirements"]
        R["Return result to Main Agent"]
        N --> R
    end

    E --> N
    R --> F --> G

    subgraph REVIEW["Review Subagent - No Regression"]
        S["Review spec compliance and code quality"]
        W["Return review result to Main Agent"]
        S --> W
    end

    G --> S
    W --> H --> I
    I --> NV
    NV -- No --> J
    NV -- Yes --> M

    subgraph VERIFY["Story Verification Subagent - One Story Only"]
        X["Verify current story using suitable tools"]
        AC["Return status, evidence, and blockers to Main Agent"]
        X --> AC
    end

    J --> X
    AC --> K --> L
    L -- Yes --> J
    L -- No --> M
```

# Rules
- Main Agent orchestrates, runs the baseline checks before any change, and produces the final report.
- `max_turns` is one shared budget covering the entire workflow; implementation, review, fixes, and per-story verification all consume from it. When it is reached, stop all work and report completed and unfinished tasks honestly.
- Every subagent returns findings, check results, evidence, and blockers to Main Agent. Subagents never call other subagents.
- Run subagents sequentially, never in parallel.
- Each verification subagent handles exactly one user story.
- Verify actual behavior, not just source code, build success, or existing test results.
- On failure, fix the current story and reverify it.
- Never finish a stage while existing checks fail; after every fix, rerun applicable checks and repeat until they pass.
- The review subagent fixes the findings it discovers before returning its result.
- No regression: do not restart completed stages or reverify previously passed stories after later fixes.
- Before making changes, read the spec and run the project's existing checks as a baseline; if any baseline check fails, make no changes and stop.
- Run only existing checks discovered from project scripts, documentation, and CI (applicable tests, lint, type-check, and build commands); skip missing ones and never create tests or check scripts.
- Never weaken acceptance criteria or claim unverified success.
- Report each story as `verified`, `failed`, `blocked`, or `unverifiable`, with evidence and blockers; explain why when it is `unverifiable`.
- When verification is skipped via `--no-verify`, baseline and implementation checks still run; report every story as `not verified` in the final report and state clearly that no E2E evidence exists. `not verified` is never reported as `verified`.