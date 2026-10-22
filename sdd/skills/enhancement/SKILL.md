---
name: enhancement
description: Guide general-purpose enhancement work through a thorough interview, an approved plan, implementation, and suitable verification.
disable-model-invocation: true
---

# Enhancement

## Workflow

### Step 1. Interview

Announce:

`Current Step: Step 1 Interview Next Step: Step 2 Enhance`

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. Ask very detailed design questions. Expose hidden assumptions. Ask the questions one at a time. Do not use AskUserQuestion Tool. Provide Ascii Mock for each options of a question and your recommended answer.

After interview present a detailed plan in the following format:

```markdown
## ASCII Mock Preview (Before/After)

[Show the current and proposed UI or behavior. For non-UI work, show the current and proposed flow, state, data shape, or output.]

## Components Affected

- [Component, module, or file path]

## Views Affected

- [View, page, service, endpoint, or data flow]

## Implementation and Verification

- [Implementation approach, suitable verification methods and tools, and known risks]
```

Wait for the user's explicit confirmation of the plan before proceeding to Step 2. If the user changes the scope materially, update the plan and get confirmation for the revised plan.

### Step 2. Enhance

Announce:

`Current Step: Step 2 Enhance Next Step: Step 3 Verify and Fix`

Inspect the existing code, conventions, and current behavior before making changes. Implement the approved enhancement using the smallest change that satisfies the plan and follows the existing project conventions. Then proceed to Step 3 to verify it and fix any issues found.

### Step 3. Verify and Fix

Announce:

`Current Step: Step 3 Verify and Fix Next Step: Done`

- Verify the approved behavior and regressions using suitable tools.
- Suitable tools include tests, logs, build tools, CLI or HTTP clients, and browser automation.
- Review the evidence. If checks fail, fix the issue within the approved scope and repeat verification. If verification cannot be completed, report the outcome and limitations.

## Rules

- Never weaken, skip, or delete tests to force success.
- Do not expand the approved scope without confirmation.
- Never claim success without verification.

## Report

Summarize the changes, affected files, verification results, and unresolved issues or limitations.
