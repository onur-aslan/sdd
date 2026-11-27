# JSON Output

Read this file at the end of a `bug-fix` run, only when the user passed `--output json`. Commit the verified fix first, then use this file to compose the final response.

## Output discipline

- Return exactly one JSON object that matches the schema below.
- Do not wrap it in Markdown fences and do not add prose before or after it.
- Keep every field present. Use `null`, `false`, `0`, or `[]` where a value does not apply.
- Report only a commit that was actually created. Never fabricate a hash or claim an unverified commit.
- Never include secrets, credentials, or full log dumps.

## Schema

```json
{
  "skill": "bug-fix",
  "status": "fixed",
  "max_turns": 5,
  "bug": {
    "description": "Checkout total ignores the discount code.",
    "root_cause": "The discount was applied before tax recalculation and then overwritten."
  },
  "reproduction": {
    "reproduced": true,
    "attempts": 2,
    "evidence": [
      "Failing test: checkout.test.js > applies a percentage discount",
      "Log: POST /checkout returned total 100 instead of 90"
    ]
  },
  "fix": {
    "attempted": true,
    "attempts": 1,
    "summary": "Recompute the total after applying the discount.",
    "files_changed": ["src/checkout/total.js"]
  },
  "verification": {
    "verified": true,
    "checks": [
      {
        "tool": "node --test",
        "target": "checkout.test.js",
        "passed": true,
        "details": "42 tests passed, 0 failed"
      }
    ]
  },
  "commit": {
    "created": true,
    "hash": "a1b2c3d",
    "branch": "fix/checkout-discount",
    "message": "fix: recompute checkout total after discount",
    "files": ["src/checkout/total.js"]
  },
  "unresolved_issues": [],
  "limitations": []
}
```

## Field rules

- `skill`: always `"bug-fix"`.
- `status`: one of `fixed`, `not_reproduced`, `unresolved`, or `blocked`.
  - `fixed`: the bug was reproduced, fixed, and verified without regression.
  - `not_reproduced`: the reproduction phase reached `max_turns` without reproducing the bug; no fix was attempted.
  - `unresolved`: the bug was reproduced but the fix-and-verify phase reached `max_turns` without a verified fix.
  - `blocked`: missing tools, access, or infrastructure prevented meaningful work.
- `max_turns`: the validated attempt limit, as a positive integer.
- `bug.description`: the reported bug, as given or normalized.
- `bug.root_cause`: the established root cause, or `null` when it could not be determined.
- `reproduction.reproduced`: boolean.
- `reproduction.attempts`: number of reproduction attempts used.
- `reproduction.evidence`: concise evidence such as failing test names, commands, and log excerpts. Use `[]` when none.
- `fix.attempted`: boolean; `false` when no fix was attempted.
- `fix.attempts`: number of fix-and-verify iterations used; `0` when no fix was attempted.
- `fix.summary`: a one-sentence description of the change, or `null` when no fix was attempted.
- `fix.files_changed`: repository-relative paths of the changed files; `[]` when none.
- `verification.verified`: boolean; `true` only when the fix was verified.
- `verification.checks`: one entry per verification run, each with `tool`, `target`, `passed`, and `details`; `[]` when no check ran.
- `commit.created`: boolean; `true` only when a commit was created for the fix.
- `commit.hash`: the commit SHA, or `null` when no commit was created.
- `commit.branch`: the branch the commit was created on, or `null`.
- `commit.message`: the commit message, or `null`.
- `commit.files`: repository-relative paths included in the commit; `[]` when none.
- `unresolved_issues`: remaining problems that still need work; `[]` when none.
- `limitations`: unavailable tools, skipped checks, or other constraints; `[]` when none.
