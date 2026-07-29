---
name: gap-analysis
description: Compare implementation results against requirements to find missing or incorrect work.
disable-model-invocation: true
---

Ask the user for the **Requirement** (which file contains the requirements/specs). Then ask for the **Implementation** (what to analyze: git diff, specific commits, a branch, or a file/directory path). Read the requirement file to understand what should be implemented. Run the appropriate git diff command to gather the implementation changes. Analyze the diff against the requirements to identify: (1) **Missing** — required changes that weren't implemented, (2) **Extra** — unnecessary additions or changes not in the requirements, and (3) **Incorrect** — changes that don't match the requirements. Present findings to the user and ask if they want to apply fixes. If yes, fix the code and tests as needed.
