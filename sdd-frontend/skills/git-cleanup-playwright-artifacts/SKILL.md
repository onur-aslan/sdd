---
name: git-cleanup-playwright-artifacts
description: Find and remove Playwright session artifacts safely after confirmation.
disable-model-invocation: true
---

Find the playwright artifacts visible in `git diff` from this session, report them to the user, and ask before deleting. If the user confirms, remove them with `git clean` .
