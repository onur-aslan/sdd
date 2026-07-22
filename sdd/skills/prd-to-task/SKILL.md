---
name: prd-to-task
description: Convert a PRD into an ordered task list with explicit implementation steps.
disable-model-invocation: true
---
This skill processes workflow step by step. Each step must be done as if Steps are prompted by user then user see result and then prompt next step. You are like an orhcestrator for user prompt. **Wait user confirmation at the and of each step**.

Gherkin Scenario outcomes (`Then` `And` blocks) must be **implementation-agnostic** and testable at the service/use-case boundary. Scenarios will serve as **integration test specifications** — structured for automated test generation. Avoid flakky test scenarios.

# Workflow

## Step 1. External Interface Analysis

Analyze the PRD to identify which external interfaces this feature uses.

1. **Identify Layers:** List all architectural layers this feature touches
2. **Identify Bottom-External-Interface:** Determine the lowest external interface
3. **Define Vertical-Slice Tasks:** Each vertical slice = one top interface component → one bottom-external-interface flow
4. **Generate ASCII Mock:** Create ASCII diagrams showing how vertical slices cut through layers
   - First show the Layer Overview Diagram (all layers + components)
   - Then show one Vertical Slice Detail Diagram per slice
   - Follow format in [reference/ascii-mock-format.md](reference/ascii-mock-format.md)

**Wait for user confirmation.**

## Step 2. Define Happy-Path Scenario

Define only one end-to-end happy-path scenario for each [vertical-slice] task.

**Wait for user confirmation.**

## Step 3. Define Edge-Case Scenarios

Define only critical end-to-end scenarios other than the [happy-path-scenario] for each [vertical-slice]

**Wait for user confirmation.**

## Step 4. Define Task Dependencies

Map dependencies between [vertical-slice] tasks exclude [enabler] and [cross-cutting] Tasks since they are merged into [vertical-slice] tasks. Determine execution order. Generate an ASCII dependency graph.

**Wait for user confirmation.**

# Input
- prd.md
# Output
- Write feature.md file strictly following [reference/feature-template.md](reference/feature-template.md) format.
- Write ONLY [vertical-slice] tasks strictly following [reference/task-template.md](reference/task-template.md) format. Do not write [enabler] and [cross-cutting] tasks.

# Out Of Scope
- Test outcomes which can be verified by UI tests