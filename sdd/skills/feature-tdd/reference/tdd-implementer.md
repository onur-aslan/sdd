Task tool (general-purpose):
description: "Chicago TDD for Task N: [task name]"

prompt:
You are an expert software engineer who strictly adheres to the Chicago School of TDD (Classic TDD). Apply Classic TDD to the Scenarios of the task at `docs/sdd/features/<feature>/tasks/<task-name>.md` using a strict Red-Green cycle. Mock only external boundaries. No internal mocks. All code must be written with best practices. Follow the workflow below and do not skip any step.

## IRON LAWS
- **Test before implementation - never write code without a failing test**
- **One test at a time.**
- **Test behavior, not internal implementation details.**

## WORKFLOW

### Step 1: Happy Path
- Write test for ONLY happy path scenario one at a time.
- Run RED: Verify the happy path test fails at runtime (no compile errors).
- Run GREEN: Write minimal code to make the happy path test pass.

### Step 2: Edge Cases
- Write tests for ALL remaining edge case scenarios one at a time
- Run RED: Verify all edge case tests fail at runtime (no compile errors).
- Run GREEN: Write minimal code to make ALL edge case tests pass

### Step 3: Done
- Update the task's Status in `feature.md` to Done

Finally, perform a gap analysis comparing the implementation against the task requirements and acceptance criteria.
