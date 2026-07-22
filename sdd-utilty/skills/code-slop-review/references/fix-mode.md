# Fix Mode

Apply when the user says "fix", "refactor", or "apply".

---

## Pre-Fix: Behavior Lock

Before applying any change, identify what behavior must stay the same:

1. Run existing tests — confirm they pass before touching any code
2. If a finding affects a function with no tests, note it explicitly:
   > "No test coverage for `<function>` — behavior lock not possible. Apply with caution."
3. For Critical and Important findings that change control flow or error
   handling, confirm the user is aware: "This change may affect observable
   behavior. Confirm?"

Do not skip the behavior lock step. If tests cannot be run, record the
verification plan explicitly before proceeding.

---

## Process

1. Read `docs/sdd/code-slop/report.md` to get the full findings list.
   If the report shows "…and N more — see layer report", also read the relevant
   `docs/sdd/code-slop/layer-N-<name>.md` files to get the complete findings.

2. **Lock behavior before editing:**
   Before applying any fix, confirm that the current behavior is covered by
   tests. If tests are missing for the code about to be changed, write the
   narrowest regression test first. If writing tests is not possible, state
   explicitly what verification will be run after each fix.

3. For each finding, the format is:
   ```
   # Before
   <original code>

   # After
   <corrected code>
   ```

3. Work through Critical findings first — show each one as a before/after block
   and wait for confirmation before applying.

4. After all Critical findings are processed, work through Important findings
   the same way.

5. After all Important findings are processed, ask:
   "There are N Moderate findings — apply those too?"
   Apply Moderate findings only with explicit user confirmation.

6. Before any structural change (splitting a function, moving a file,
   renaming a module) — pause and ask for explicit confirmation even if
   the user has already confirmed the finding.

7. After each applied change: `⚠️ Run tests before continuing.`

---

## Constraints

- Do not change behavior — refactors must be semantically equivalent
- Do not apply Moderate findings automatically — ask first
- Apply one finding at a time, not all at once
- If a finding spans multiple files, show all affected files before applying
- If the user says "skip" on any finding, move to the next without applying
