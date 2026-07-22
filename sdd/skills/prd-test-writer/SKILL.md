---
name: prd-test-writer
description: Orchestrates test writing for each User Story's Acceptance Criteria (AC) in a PRD. Uses general-purpose Task Tool in parallel for each US. Orchestrator writes all reports from agent output.
disable-model-invocation: true
---

# PRD Test Writer

Announce at start: "prd-test-writer: Analyzing PRD for User Stories and Acceptance Criteria..."

---

## Workflow

### Step 1. Read PRD and Extract User Stories

Read `docs/sdd/features/<feature-name>/prd.md` and extract:
- All User Stories from the User Stories table (Section 5)
- For each User Story: ID (US-01, US-02, etc.), description, and Acceptance Criteria list

**Validation:** If no User Stories found, exit with: "No User Stories found in PRD"

### Step 2. Spawn Task Tools in Parallel

For each User Story that needs tests, use the Task tool with `subagent_type=general-purpose`.

Read the template at [references/user-story-test-writer-prompt.md](references/user-story-test-writer-prompt.md) and replace placeholders:

| Placeholder | Value |
|---|---|
| `<us-id>` | e.g. US-01 |
| `<us-description>` | Full User Story text |
| `<ac-list>` | Bulleted Acceptance Criteria (one per line, each prefixed with `- `) |

**Announce:** "Launching <N> test-writer tasks in parallel..."

### Step 3. Wait for All Tasks to Complete

Wait for all parallel test-writer tasks to finish.

### Step 4. Aggregate Results

Collect results from all test-writer tasks:
- ✅ Passed: User Stories with tests written successfully
- ❌ Failed: User Stories where test writing failed

For each successful task, extract from the agent output:
- Test file path created (must start with `US_` prefix, e.g., `US_01-*.test.ts`)
- Test count
- AC coverage details

### Step 5. Generate Feature Test Report

Write `docs/sdd/features/<feature-name>/test-report.md`:

```markdown
# Feature Test Report: <feature-name>

| Metadata | Value |
|----------|-------|
| Feature | <feature-name> |
| PRD | docs/sdd/features/<feature-name>/prd.md |
| Total User Stories | <N> |
| Tests Written | <N> |

## User Story Results

| US-ID | Description | Test File | Status | Test Count |
|-------|-------------|-----------|--------|------------|
| US-01 | ... | US_01-*.test.ts | ✅ | 5 |
| US-02 | ... | US_02-*.test.ts | ✅ | 3 |
```

### Step 6. Finish

Announce completion with summary: feature name, user stories processed, tests written, and report location.

---

## Principles

- **Parallel Execution**: All test-writer tasks run in parallel for speed
- **AC-Driven**: Tests are derived from Acceptance Criteria only
- **No Source Modifications**: This skill only writes tests, never modifies production code
- **Orchestrator Writes Reports**: Test-writer agents return results directly; the orchestrator writes all reports
- **Aggregated Report**: One feature-level report summarizes all results