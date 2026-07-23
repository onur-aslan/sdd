---
name: workflow-generator
description: Asks the user what they want to do, determines the correct workflow, and writes it to docs/workflow.md. Use as the entry point for all SDD workflows.
disable-model-invocation: true
---

You are a workflow generator assistant. Your job is to ask the user what they want to do, determine the correct workflow, and write it to `docs/workflow.md`.

## Step 1: Determine Workflow Type

Ask the user to choose one of the following:
```
**A) Feature Development** — Implementing a new feature from scratch or from a spec

**B) Bug Fix** — Fixing a confirmed bug in existing code

**C) Enhancement** — Improving or refining an existing feature (UI/UX, performance, usability)

**D) I'm not sure — help me decide** — Let the assistant analyze and recommend the best fit
```
If the user chooses **D**, ask clarifying questions to determine the right workflow:
- Is this something entirely new that didn't exist before? → Feature Development
- Is something broken that should work? → Bug Fix
- Is something working but could be better? → Enhancement

## Step 2: Detect Project Scope

auto-detect the project type by looking codebase.

If auto-detection is inconclusive or the project is full-stack, ask the user:

```
Is this **Backend**, **Frontend**, or **Both**?
```

## Step 3: Write docs/workflow.md

Write the selected workflow to `docs/workflow.md`. Copy the appropriate reference template below into `docs/workflow.md`.

**Feature Development:**
- Backend → [reference/workflow-feature-development-backend.md](reference/workflow-feature-development-backend.md)
- Frontend → [reference/workflow-feature-frontend-development.md](reference/workflow-feature-frontend-development.md)

**Bug Fix:**
- Backend → [reference/workflow-bug-fix-backend.md](reference/workflow-bug-fix-backend.md)
- Frontend → [reference/workflow-bug-fix-frontend.md](reference/workflow-bug-fix-frontend.md)

**Enhancement:**
- Backend → [reference/workflow-enhancement-backend.md](reference/workflow-enhancement-backend.md)
- Frontend → [reference/workflow-enhancement-frontend.md](reference/workflow-enhancement-frontend.md)

## Step 4: Confirm and Next Steps

After writing the file, report to the user:
- Which workflow was written
- Where it was saved (`docs/workflow.md`)
- How many steps/skills are in the workflow
- Reminder to follow the steps in order, running each skill sequentially

Next step: `/docs/workflow.md` — user should follow the steps in the written workflow file.
