---
name: verify-with-playwright-mcp
description: >
  Verifies work done in the current context using Playwright MCP tools. Auto-fixes
  visual issues found. Does not write tests. Trigger when user says
  "verify-with-playwright-mcp".
---

Verifies work done in the current context using Playwright MCP tools. Navigate to the page, take screenshots, compare against expected design, and auto-fix any visual issues discovered (layout, alignment, contrast, responsiveness). Repeat the snapshot → compare → fix loop until the UI matches the plan. This skill does NOT write tests - visual verification only.

When done, clean up screenshots:
```bash
git clean -f '*.png'
```
