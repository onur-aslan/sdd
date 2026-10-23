---
name: bug-sweep
description: Run one unattended bug-sweep item by delegating the fix to the bug-fix skill in a fresh subagent and preparing the JSON result. Invoke only from sdd bug-sweep.
disable-model-invocation: true
---

# Bug Sweep

Fix exactly one bug for an unattended sweep. You orchestrate; the `bug-fix` skill does the work.

## Workflow

1. Read the task file named in the invocation. It contains the bug, the attempt limit, and the result file.
2. Spawn one fresh general-purpose subagent. Give it the bug details and task instructions from the task file. Tell it to:
   - Invoke the `bug-fix` skill by name, then follow it.
   - Pass the task file's `max_turns` value to the `bug-fix` skill.
   - Work only on this bug. Do not commit, push, or change the tracker.
   - Return its normal `bug-fix` report: root cause, changes, verification, evidence, and whether the bug is fixed.
3. Wait for the subagent. Use its report to prepare the JSON object required by the task file.
4. Write exactly one JSON object to the result file, without Markdown. If the subagent failed, could not reproduce or verify the fix, or gave too little evidence, use `"not-fixed"` with a short `reason`.
5. Return the same JSON object as your final answer. Do not add prose.

## Result

The task file is authoritative. You prepare this object from the subagent's report. The shape is:

```json
{
  "key": "ABC-1",
  "status": "fixed",
  "summary": "One line describing the change",
  "how": "Short explanation of the root cause and the fix",
  "critical": false,
  "criticalReason": "",
  "evidence": ["command or manual verification"]
}
```

- `status` is `"fixed"` or `"not-fixed"`.
- For `"not-fixed"`, replace `summary` and `how` with `reason` and keep `evidence`.
- Use `"fixed"` only when verification passed and the working tree contains the fix.
- Set `critical` to `true` for authentication, authorization, security, payments, data migrations, infrastructure, CI/CD, or uncertain production behavior. `criticalReason` is required when `critical` is true.

## Rules

- One bug, one subagent.
- Do not fix the bug yourself; the subagent must invoke `bug-fix`.
- Do not ask questions, commit, push, or change the tracker.
- Do not invent evidence. If the subagent cannot reproduce or verify the fix, report `"not-fixed"`.
- If the subagent cannot invoke `bug-fix`, report `"not-fixed"`; do not fall back to fixing it yourself.
