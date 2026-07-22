# Layer 1 — Structural Slop Reference

AI adds code; it does not refactor. It generates the pattern it saw most often
in training — not the pattern that fits your architecture.

---

## Pattern 1 — God X (Function / Class / Module / Service)

Any single unit that does more than one thing at one level of abstraction —
i.e., it has multiple responsibilities.

### 1a — God Function

A function with multiple responsibilities.

**What to flag:**
- Comment-separated sections inside the function
- "and" in the function name (fetch_and_save, validate_and_send)
- Mixed abstraction levels (DB query + string formatting in one function)
- Deep nesting
- Too many parameters

### 1b — God Class

A class with multiple unrelated responsibilities.

**What to flag:**
- Comment-separated sections
- Multiple unrelated responsibilities (e.g., DB ops + HTTP + file I/O in one class)
- Too many public methods
- Too many instance variables
- Generic responsibility names: "Manager", "Handler", "Processor", "Service"

### 1c — God Module

A module that exports too many unrelated things.

**What to flag:**
- Too many exports
- Mixed concerns (e.g., date helpers + string helpers + math helpers)
- Comment-separated sections inside the module
- Generic file names: utils, helpers, common, shared, misc

### 1d — God Service

A service that handles too many business capabilities.

**What to flag:**
- Service handles many distinct business capabilities
- Service has dependencies on many external services/repos
- Generic service names: UserService, OrderService, PaymentService
- Service imports from many other modules
- Service is imported by more than half the codebase

---

## Pattern 2 — Semantic Duplication

The same logic appearing in multiple places with different variable names or entity nouns.

**What to flag:**
- Parallel function shapes with identical structure, differing only by:
  - Column name
  - Role string
  - Entity noun

---

## Pattern 3 — Wrong Abstraction

Abstractions introduced because they exist in training data, not because the code needs them.

**What to flag:**
- Interface or base class with exactly one non-test implementor
- Single-method wrapper class that only delegates
- Config object used in very few places

---

## Pattern 4 — Scaffolding Remnants

Placeholder implementations instead of real logic.

**What to flag:**
- pass statements in non-abstract functions
- return None / return null when return type is not nullable
- NotImplementedError / UnsupportedOperationException
- panic("not implemented") / unimplemented!() / todo!()
- TODO: implement / placeholder / stub comments

---

## Pattern 5 — Re-Inventing Existing Utilities

New helper function for logic that already exists elsewhere in the codebase.

**What to flag:**
- New utility function with a near-identical counterpart already existing
- New function with similar name/purpose to an existing utility

---

## Detection Checklist

```
□ Any function with multiple responsibilities?
□ Any function with comment-separated sections?
□ Any function with "and" in its name?
□ Any function with deep nesting?
□ Any class with multiple unrelated responsibilities?
□ Any class with comment-separated sections?
□ Any class with too many public methods or instance variables?
□ Any class with generic responsibility name?
□ Any module with too many exports?
□ Any module with mixed concerns?
□ Any module with generic name (utils/helpers/common)?
□ Any service handling too many business capabilities?
□ Any service with too many external dependencies?
□ Any semantic duplication (same logic, different names)?
□ Any interface with exactly one non-test implementor?
□ Any single-method wrapper class?
□ Any config object used in very few places?
□ Any placeholder implementation (pass/null/not implemented)?
□ Any TODO: implement / placeholder / stub comments?
□ Any new utility that duplicates an existing one?
```

---

## Severity Guide

| Finding                             | Bucket       |
|-------------------------------------|--------------|
| Function with multiple responsibilities | 🟡 Moderate  |
| Function that is very long          | 🟠 Important |
| Function that is extremely long     | 🔴 Critical  |
| Class with multiple responsibilities | 🟡 Moderate  |
| Class that is very long             | 🟠 Important |
| Class that is extremely long        | 🔴 Critical  |
| Module with mixed concerns          | 🟡 Moderate  |
| Module that is very long            | 🟠 Important |
| Module that is extremely long       | 🔴 Critical  |
| Service with many capabilities      | 🟠 Important |
| Semantic duplication (per instance) | 🟠 Important |
| Interface with single implementor   | 🟠 Important |
| Single-method wrapper class         | 🟡 Moderate  |
| Mixed abstraction levels in a unit  | 🟠 Important |
| Scaffolding remnant (placeholder)   | 🔴 Critical  |
| Re-invented existing utility        | 🟠 Important |
