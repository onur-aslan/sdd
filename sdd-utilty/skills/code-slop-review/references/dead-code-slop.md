# Layer 5 — Dead Code Slop Reference

AI generates code in bulk. It doesn't prune. Dead code accumulates silently.

---

## Pattern 1 — Unused Imports

Imports that are never referenced in the file.

**What to flag:**
- Any import statement where the imported name is never used

---

## Pattern 2 — Unreachable Code

Code that can never execute.

**What to flag:**
- Statements after an unconditional return/exit/break/continue
- Branches that can never be true given the surrounding logic
- Exception handlers for exceptions that the try block cannot raise

---

## Pattern 3 — Unused Variables and Parameters

Variables assigned but never read. Parameters declared but never used.

**What to flag:**
- Variable assigned at the top of a function and never referenced
- Parameter in a function signature that the body ignores entirely
- Loop variable assigned but only the loop side-effect matters

**Do NOT flag:**
- Variables prefixed with underscore (intentionally unused)
- Parameters required by an interface or callback contract
- Unused parameters in test fixtures or framework callbacks

---

## Pattern 4 — Dead Feature Flags and Stale Config

Hard-coded boolean flags that always evaluate to the same value.

**What to flag:**
- if True: / if False: blocks
- ENABLE_*, USE_*, FLAG_* constants that are never toggled
- Config values that are overridden immediately
- Feature toggles from completed migrations

---

## Pattern 5 — Debug Artifacts

Logging, printing, or assertions left from development.

**What to flag:**
- print() / console.log() / System.out statements
- debugger; / pdb.set_trace() / breakpoint() calls
- panic() calls used for debugging
- DEBUG / TEMP / REMOVE / HACK comments

**Do NOT flag:**
- Structured logging through the project's logger

---

## Pattern 6 — Commented-Out Code

Blocks of code that have been commented out instead of deleted.

**What to flag:**
- Multi-line comment blocks that contain code

**Do NOT flag:**
- Single-line comments that explain why something is NOT done
- Commented-out code with an explicit explanation of why it is kept

---

## Detection Checklist

```
□ Any imports that are never used in the file?
□ Any code after an unconditional return/exit/break?
□ Any variables assigned but never read?
□ Any parameters declared but never used (without _ prefix)?
□ Any boolean constants that are always true or always false?
□ Any print/console.log/debugger statements?
□ Any DEBUG / TEMP / REMOVE comments?
□ Any large commented-out code blocks?
```

---

## Severity Guide

| Finding                                     | Bucket       |
|---------------------------------------------|--------------|
| Unused import                               | 🟡 Moderate  |
| Unreachable code after unconditional exit   | 🟠 Important |
| Unused variable or parameter                | 🟡 Moderate  |
| Dead feature flag (always true/false)       | 🟠 Important |
| Debug artifact (print, console.log, etc.)   | 🟠 Important |
| Commented-out code block                    | 🟡 Moderate  |
