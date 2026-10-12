---
name: verify-with-curl
description: >
  Verifies work done in the current context using curl. Auto-fixes issues found.
  Does not write tests. Invoke ONLY when the `verify-with-curl` skill is
  explicitly named — by the user (e.g. /verify-with-curl) or by another
  skill/prompt instructing to invoke verify-with-curl by name. Never select this
  skill by matching a task description to it.
---

Verifies work done in the current context using curl commands. Test API endpoints, inspect responses, validate status codes, headers, and response bodies. Auto-fix any issues discovered. Restart the app at the start of each iteration, then repeat the curl → compare → fix loop until the API matches the expected behavior. This skill does NOT write tests - manual verification only.
