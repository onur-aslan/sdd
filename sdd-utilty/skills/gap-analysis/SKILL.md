---
name: gap-analysis
disable-model-invocation: true
---

Ask the user for the **source** (what to analyze: git diff, specific commits, a branch, or a file/directory path). Then ask for the **destination** (compare against: main branch, another branch, a specific commit, or a file/directory path). Run the appropriate git diff command to gather the differences. Analyze the diff yourself to identify: (1) **Missing** — changes that should have been made but weren't, (2) **Extra** — unnecessary additions or changes, and (3) **Incorrect** — changes that don't match the intent. Present findings to the user and ask if they want to apply fixes. If yes, fix the code and tests as needed.
