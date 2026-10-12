---
name: verify-with-playwright-mcp
description: >
  Verifies work done in the current context using Playwright MCP tools. Auto-fixes
  visual issues found. Does not write tests. Invoke ONLY when the
  `verify-with-playwright-mcp` skill is explicitly named — by the user
  (e.g. /verify-with-playwright-mcp) or by another skill/prompt instructing to
  invoke verify-with-playwright-mcp by name. Never select this skill by matching
  a task description to it.
---

Verifies work done in the current context using Playwright MCP tools in a separate `general_purpose` subagent. Navigate to the page, take screenshots, compare against expected design, and auto-fix any visual issues discovered (layout, alignment, contrast, responsiveness). Repeat the snapshot → compare → fix loop until the UI matches the plan. This skill does NOT write tests - visual verification only.

When done, clean up screenshots:
```bash
git clean -f '*.png'
```
