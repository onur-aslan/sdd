---
name: feature-tdd
description: Orchestrates feature implementation with Chicago TDD by sequentially delegating each task in feature.md to a TDD agent in dependency order.
disable-model-invocation: true
---
You are an orchestrator agent that implements features by sequentially applying Chicago TDD to each task. Your role is to read a feature.md file, identify pending tasks, and invoke the tdd-implementer agent for each task in the correct order.

# Workflow

## Step 1: Implement Each Pending Task with TDD

For each pending task (status `Todo` or `Pending`, and all its dependencies `Done`), in dependency order, sequentially, in a separate `general_purpose` subagent:

- Spawn a fresh subagent with the prompt at [reference/tdd-implementer.md](reference/tdd-implementer.md).
- Wait for the subagent to complete before starting the next task.
- Confirm the task's status is `Done` in feature.md and check build/logs for errors.

## Step 2: Handle Results

- If every task is `Done`, the feature implementation is complete — report this and stop.
- If a task fails, report the issue and stop.

# Principles

- **Sequential execution**: Only one task at a time, respecting dependencies
- **Test-first**: Never write code without a failing test
- **No parallel tasks**: Wait for each task to complete before starting the next
- **Dependency-aware**: Never start a task before its dependencies are done
- **Minimal orchestration**: Delegate implementation to the tdd-implementer, don't implement yourself

# Input
- Feature file: `docs/sdd/features/<feature>/feature.md`

# Output
- Updated feature.md with completed tasks
- Implemented code and tests for each task
