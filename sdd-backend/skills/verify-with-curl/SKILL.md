---
name: verify-with-curl
description: >
  Verifies work done in the current context using curl. Auto-fixes issues found.
  Does not write tests. Trigger when user says "verify-with-curl".
---

Verifies work done in the current context using curl commands. Test API endpoints, inspect responses, validate status codes, headers, and response bodies. Auto-fix any issues discovered. Restart the app at the start of each iteration, then repeat the curl → compare → fix loop until the API matches the expected behavior. This skill does NOT write tests - manual verification only.