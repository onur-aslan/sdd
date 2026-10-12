---
name: implementer
description: Implement the current context into code and verify it builds cleanly. Invoke ONLY when the `implementer` skill is explicitly named — by the user (e.g. /implementer) or by another skill/prompt instructing to invoke implementer by name. Never select this skill by matching a task description to it.
---

Implement whatever has been defined in the current context by writing/modifying code. Run build/compile to verify no errors. Fix any build errors. Then perform a gap analysis comparing what was implemented against the original requirements.

## Out of scope

- Writing tests
