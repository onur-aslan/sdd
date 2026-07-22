---
name: backend-enhancement
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

Follow this process for each enhancement:

1. **Write failing test** - Write a **unit test** that exercises the new or changed code path:
   - Test should exercise the real code path being enhanced
   - Mock only external boundaries (database, external APIs, file system)
   - No internal mocks - test through the real service/controller layer
   - Verify the test FAILS before proceeding

2. **Fix** - Implement the minimal possible fix to make the test pass

Ensure the build passes without errors after completing the changes.

After completing the changes, invoke the `verify-with-curl` skill to validate and auto-fix any issues.
