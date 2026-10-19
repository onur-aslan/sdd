---
name: feature-e2e-verifier
description: Verify every User Story and all its Acceptance Criteria sequentially using a separate subagent per story. Fix discovered issues and re-verify. Invoke only when explicitly named by the user or another skill/prompt.
disable-model-invocation: true
---

# Feature E2E Verifier

## Suitable Tools

Use these tools for verification and debugging as appropriate; not every tool is required.

- Playwright MCP
- Python
- curl
- CLI tools
- Tests
- Logs
- Build tools

## Workflow

```mermaid
flowchart TD
    A([Start]) --> B[Ensure full-stack environment is running]
    B --> C{Environment ready?}
    C -->|No| X[Report blocker]
    C -->|Yes| D[Enumerate User Stories and all ACs]
    D --> E[Select next unverified User Story]
    E --> F[Spawn fresh general-purpose subagent]
    F --> G[Verify all ACs and fix discovered issues]
    G --> H[Re-verify and record results]
    H --> I{More User Stories?}
    I -->|Yes| E
    I -->|No| J[Report final results]
    J --> K([Done])
    X --> K
```

## Rules

- Ensure the full-stack environment is running before verification. Start it if needed; if it cannot be started, report the blocker and stop.
- Enumerate all User Stories and their complete Acceptance Criteria from the provided context or specification.
- Use a separate, fresh `general_purpose` subagent for each User Story.
- Pass the complete User Story, all its Acceptance Criteria, and relevant project context to the subagent.
- Require each subagent to use the suitable tools listed under **Suitable Tools** for verification and debugging. Select tools based on the task; not every tool is required.
- Wait for each subagent to finish before starting the next. Never verify User Stories in parallel.
- Verify every Acceptance Criterion for the current User Story in the same subagent run.
- If an issue is found, investigate, apply the smallest appropriate fix, and re-verify the affected behavior using suitable tools.
- Record each Acceptance Criterion as passed, failed, or blocked, along with fixes and relevant evidence.
- Mark a User Story as verified only when all its Acceptance Criteria pass. Otherwise, report unresolved issues.

## Report

Summarize each User Story, the result of each Acceptance Criterion, fixes applied, and unresolved issues. State whether all User Stories are verified or list the remaining failures and blockers.