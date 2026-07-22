---
name: frontend-enhancement
disable-model-invocation: true
---

## Workflow

### Step 1. Interview

Announce: `Current Step: Step 1 Interview Next Step: Step 2 Enhance`

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. Ask very detailed design questions. Expose hidden assumptions. Ask the questions one at a time. Do not use AskUserQuestion Tool. Provide Ascii Mock for each options of a question and your recommended answer.

After interview present a detailed plan in the following format:

```markdown
# Plan Format

## ASCII Mock Preview (Before/After)

[Visual comparison using ASCII Mock Preview]

## Components Affected

- [Component/File path 1]
- [Component/File path 2]

## Views Affected

- [View/Page path 1]
- [View/Page path 2]

```

**Wait for user confirmation** on the plan before proceeding to Step 2.

### Step 2. Enhance

Announce: `Current Step: Step 2 Enhance Next Step: Done`

Make the UI change according to plan following frontend best practices. Ensure the build passes without errors after completing the changes.

After completing the changes, invoke the `verify-with-playwright-mcp` skill to validate and auto-fix any visual issues.
