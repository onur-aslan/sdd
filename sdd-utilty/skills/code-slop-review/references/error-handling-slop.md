# Layer 3 — Error Handling Slop Reference

AI adds error handling blocks to make code "look safe" — but silently swallows
errors, returns null/None to callers who don't expect it, and makes production
debugging nearly impossible.

---

## Pattern 1 — Silent Swallow

Catching an exception and doing nothing.

**What to flag:**
- except Exception: pass
- except: pass
- Empty catch blocks
- Ignoring error results (Go: `_ = someCall()`, Rust: `let _ = some_call()`)

---

## Pattern 2 — Null Return on Failure

Catching an exception and returning None/null/nil without documented contract.

**What to flag:**
- Return None/null/nil on exception without documented contract

**Do NOT flag:**
- Returning default on "not found" errors when the value is genuinely optional
- Caller's contract explicitly treats absence as "use defaults"

---

## Pattern 3 — Catch-All Exception

Catching the broadest possible exception instead of the specific exception the
code can actually handle.

**What to flag:**
- except Exception as e
- catch (e) without specificity
- catch (Exception e)

---

## Pattern 4 — Missing Context in Logs

Error logs without identity, operation, or input context.

**What to flag:**
- logger.error("Error: %s", e) without context variables
- console.error("Error:", e) without identity information
- Log statements that only print the exception message

---

## Pattern 5 — Resource Leak

File, connection, or socket opened without structured cleanup.

**What to flag:**
- Files opened without context manager or try/finally
- Database connections without cleanup
- Sockets/HTTP clients without proper close

---

## Pattern 6 — Inconsistent Error Contract

Different functions in the same module handle errors differently.

**What to flag:**
- Some functions raise on failure, others return null/None
- Some functions return error objects, others raise
- The same error condition handled differently in different functions

---

## Detection Checklist

```
□ Any bare catch/except without re-raise or logging?
□ Any catch block ending with return None/null/nil?
□ Any log statement without identity/context variables?
□ Any file/connection/socket opened without structured cleanup?
□ Any catch block catching broader than necessary?
□ Does the module mix raise/throw and return null for the same class of failure?
```

---

## Severity Guide

| Finding                                   | Bucket       |
|-------------------------------------------|--------------|
| Bare pass/empty in except block           | 🔴 Critical  |
| Return null on exception (no contract)    | 🟠 Important |
| Bare catch-all exception                  | 🔴 Critical  |
| Log without context (no ids/values)       | 🟡 Moderate  |
| Resource leak (no structured cleanup)     | 🟠 Important |
| Inconsistent error contract within module | 🟠 Important |
