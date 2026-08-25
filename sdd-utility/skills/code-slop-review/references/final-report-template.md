# Final Report Template

Write this structure to `docs/sdd/code-slop/report.md`.
Fill every `<placeholder>` from the aggregated layer data.

---

```markdown
# Code Slop Review Report

**Date:** <ISO date>
**Scope:** <scope descriptor>
**Files reviewed:** <N>
**Slop level:** <emoji + label>
**Findings:** Critical: <C>, Important: <I>, Moderate: <M>

---

## 🔴 Critical (fix before merge)
- `<file>:<line>` — <description> [Layer <N>]
  → Fix: <one-line fix suggestion>

## 🟠 Important
- `<file>:<line>` — <description> [Layer <N>]
  → Fix: <one-line fix suggestion>
<!-- Show a representative subset. If more: "…and N more — see layer report." -->

## 🟡 Moderate
- `<file>:<line>` — <description> [Layer <N>]
  → Fix: <one-line fix suggestion>
<!-- Show a representative subset. If more: "…and N more — see layer report." -->

## 💡 Architecture Notes
<!-- Aggregated from docs/sdd/code-slop/layer-4-architecture.md Notes section.
     Omit this section if Layer 4 did not run. -->

## 📊 Summary by Layer

| Layer | 🔴 Critical | 🟠 Important | 🟡 Moderate |
|-------|-------------|--------------|-------------|
| 1 — Structural | <N> | <N> | <N> |
| 2 — Tests | <N> | <N> | <N> |
| 3 — Error Handling | <N> | <N> | <N> |
| 4 — Architecture | <N> | <N> | <N> |
| 5 — Dead Code | <N> | <N> | <N> |
| **Total (after dedup)** | **<C>** | **<I>** | **<M>** |

## Layer Reports
<!-- Omit links for layers that were skipped (no output file exists) -->
- [Layer 1 — Structural](layer-1-structural.md)
- [Layer 2 — Tests](layer-2-tests.md)
- [Layer 3 — Error Handling](layer-3-error-handling.md)
- [Layer 4 — Architecture](layer-4-architecture.md)
- [Layer 5 — Dead Code](layer-5-dead-code.md)
```
