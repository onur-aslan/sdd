# Layer 2 — Test Slop Reference

AI-generated tests mirror the implementation — they pass because they were
written alongside the code, not because they validate behavior.

---

## Pattern 1 — Implementation Mirror Test

The test asserts internal state or intermediate values rather than observable
behavior from the caller's perspective.

**What to flag:**
- Tests that break if you rename a private field or extract a private method
- Tests that describe how the function does it, not what it guarantees

---

## Pattern 2 — Meaningless Assertions

Assertions that always pass or verify nothing actionable.

**What to flag:**
- Checks for non-nullity without verifying content
- Checks for empty/non-empty without verifying correctness
- Type checks without behavioral assertions
- Status code checks without payload assertions

---

## Pattern 3 — Happy Path Only

Only the obvious success case is tested.

**What to flag (missing tests for):**
- Empty input
- Boundary values
- When dependencies raise exceptions
- None / null / nil inputs
- Duplicate values
- Idempotency (operation called twice)
- Negative tests (what the function guarantees it will NOT do)

---

## Pattern 4 — Mock Overuse

Everything is mocked to make tests pass in isolation, but mocks don't represent real behavior.

**What to flag:**
- Tests that only verify a mock method was called, without checking arguments
- Tests where mocking makes the assertion trivial

---

## Pattern 5 — No Test Files At All

The codebase or module being reviewed has no test files whatsoever.

**What to flag:**
- No test files found in the code scope → single Critical finding
- Do not run Patterns 1–4 if no tests exist

---

## Detecting Missing Tests

**What to check:**
- All public functions/methods should have corresponding tests

**Do NOT flag:**
- Private helpers
- Constructors
- Property getters
- Dunder/magic methods

---

## Severity Guide

| Finding                                      | Bucket       |
|----------------------------------------------|--------------|
| Implementation mirror assertion              | 🟠 Important |
| Meaningless assertion                        | 🟡 Moderate  |
| Happy path only (missing error cases)        | 🟠 Important |
| Mock overuse (no meaningful assertion)       | 🟡 Moderate  |
| No tests at all for a public function        | 🟠 Important |
| No test files exist in the codebase/module   | 🔴 Critical  |
