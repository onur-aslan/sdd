---
name: spec-to-task
description: Convert a spec into an ordered task list with explicit implementation steps.
disable-model-invocation: true
---
This skill processes the workflow step by step, autonomously from start to finish. Work through every step without pausing for user confirmation, then produce the final outputs once all steps are complete.

Gherkin Scenario outcomes (`Then` `And` blocks) must be **implementation-agnostic** and testable at the service/use-case boundary. Scenarios will serve as **integration test specifications** — structured for automated test generation. Avoid flaky test scenarios.

# Workflow

## Step 1. External Interface Analysis

Analyze the spec to identify which external interfaces this feature uses.

1. **Identify Layers:** List all architectural layers this feature touches
2. **Identify Bottom-External-Interface:** Determine the lowest external interface
3. **Define Vertical-Slice Tasks:** Each vertical slice = one top interface component → one bottom-external-interface flow
4. **Generate ASCII Mock:** Create ASCII diagrams showing how vertical slices cut through layers
   - First show the Layer Overview Diagram (all layers + components)
   - Then show one Vertical Slice Detail Diagram per slice
   - Follow format in [reference/ascii-mock-format.md](reference/ascii-mock-format.md)

## Step 2. Define Happy-Path Scenario

Define only one end-to-end happy-path scenario for each [vertical-slice] task.

## Step 3. Define Edge-Case Scenarios

Define only critical end-to-end scenarios other than the [happy-path-scenario] for each [vertical-slice].

## Step 4. Define Task Dependencies

Map dependencies between [vertical-slice] tasks exclude [enabler] and [cross-cutting] Tasks since they are merged into [vertical-slice] tasks. Determine execution order. Generate an ASCII dependency graph.

# Input
- spec.md
# Output
- Write `docs/sdd/features/<feature-name>/layers.md` with the layer overview and vertical-slice diagrams (following [reference/ascii-mock-format.md](reference/ascii-mock-format.md)).
- Write feature.md file strictly following [reference/feature-template.md](reference/feature-template.md) format.
- Write ONLY [vertical-slice] tasks strictly following [reference/task-template.md](reference/task-template.md) format. Do not write [enabler] and [cross-cutting] tasks.

# Out Of Scope
- Test outcomes which can be verified by UI tests
