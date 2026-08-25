# Layer 4 — Architecture Slop Reference

AI generates code by pattern-matching against training data. Over months this
produces a codebase where every module is internally consistent but
architecturally foreign to the others.

---

## Step 0 — Detect the Project's Architecture First

Before applying any rule, identify which architecture the project uses.

**Look for these signals:**
- Layered / DDD → directories named domain/, service/, repository/, infrastructure/
- MVC → directories named models/, views/, controllers/
- Hexagonal → directories named ports/, adapters/, core/
- Modular monolith → directories named modules/, features/, domains/
- Serverless → handler functions in root or functions/
- Minimal API → single file or flat structure, no layer separation

**Apply layer boundary rules (Patterns 1 and 4) only for Layered, DDD, or Hexagonal architectures.**

---

## Pattern 1 — Layer Boundary Violation

Each architectural layer has a responsibility.

**What to flag:**
- DB query inside a controller
- Business logic inside a repository
- Domain model importing from infrastructure

---

## Pattern 2 — Magic Values

Hard-coded literals with no named constant.

**What to flag:**
- Unexplained numbers
- Status strings
- Service URLs that vary by environment

**Do NOT flag:**
- Public third-party API endpoints
- Stable application constants

---

## Pattern 3 — Pattern Inconsistency

Multiple distinct patterns for the same cross-cutting concern.

**What to flag:**
- Multiple patterns for DB access
- Multiple error response formats
- Multiple logging styles
- Multiple validation approaches

---

## Pattern 4 — Dependency Direction Violation

Outer layers depend on inner layers — never the reverse.

**What to flag:**
- Domain importing from infrastructure
- Inner layer depending on outer layer concrete implementations

---

## Pattern 5 — Configuration Slop

Values that vary between environments hardcoded in source.

**What to flag:**
- Database URLs
- Internal service URLs
- API keys
- DEBUG flags
- ALLOWED_HOSTS

**Do NOT flag:**
- Stable application constants

---

## Pattern 6 — Async/Sync Mismatch

**What to flag:**
- Blocking call inside an async function
- Unnecessary async function with no await statements

---

## Detection Checklist

```
□ Is there DB access / HTTP calls inside a controller or route handler?
□ Is there business logic inside a repository?
□ Does a domain model import from infrastructure?
□ Are there multiple patterns for the same cross-cutting concern?
□ Are there multiple error response formats?
□ Are there hardcoded credentials, URLs, or environment-specific values?
□ Are there blocking calls inside async functions?
□ Are there unnecessary async functions with no await statements?
□ Are there magic numbers or strings without named constants?
```

---

## Severity Guide

| Finding                                       | Bucket       |
|-----------------------------------------------|--------------|
| Magic number or string (per occurrence)       | 🟡 Moderate  |
| DB access in controller                       | 🔴 Critical  |
| Business logic in repository                  | 🔴 Critical  |
| Domain importing infrastructure               | 🔴 Critical  |
| Multiple patterns for same concern            | 🟠 Important |
| Multiple error response formats               | 🟡 Moderate  |
| Hardcoded credential / secret / API key       | 🔴 Critical  |
| Hardcoded env-specific value (non-credential) | 🟡 Moderate  |
| Blocking call inside async function           | 🔴 Critical  |
| Unnecessary async function                    | 🟡 Moderate  |
