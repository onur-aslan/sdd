# Aggregate and Report

Runs after all explore agents have written their layer output files.
Reads `docs/sdd/code-slop/layer-*.md`, counts findings by bucket, and produces
the final report.

---

## 1 — Collect and Deduplicate

List all files in `docs/sdd/code-slop/` and read every file matching
`layer-*.md`. Skipped layers will not have an output file — skip missing files silently.

If the same `file:line` appears in multiple layer outputs, count it once
using the highest bucket priority (🔴 Critical > 🟠 Important > 🟡 Moderate).
Mark the lower-priority duplicates in the summary as "covered by Layer N — not scored."

---

## 2 — Count

Each layer file contains bucket labels per finding (Critical / Important / Moderate),
assigned by the layer reference file. Count findings per bucket after deduplication:

```
Critical count  → C
Important count → I
Moderate count  → M
```

Determine overall slop level by context:
- Zero Critical, minimal Important → 🟢 Clean
- Zero Critical, notable Important → 🟡 Mild Slop
- Some Critical findings → 🟠 Heavy Slop
- Many Critical findings → 🔴 Full Slop

> **Note:** These levels are scope-agnostic. A single-file review with Critical
> findings is proportionally more severe than a full-codebase review with the same.
> Note the scope in the report header so the reader can calibrate.

---

## 3 — Write Final Report

→ Read [final-report-template.md](final-report-template.md) for the report structure.

Fill every placeholder from the aggregated layer data and write the result
to `docs/sdd/code-slop/report.md`.

---

## 4 — Present to User

Display the contents of `docs/sdd/code-slop/report.md` to the user.

**Report size cap when displaying:**
- 🔴 Critical: always show all
- 🟠 Important: show a representative subset; group remainder as "…and N more"
- 🟡 Moderate: show a representative subset; group remainder as "…and N more"

End with — unless the user already triggered Fix Mode:
> "Full layer reports saved to `docs/sdd/code-slop/`. Should I apply the refactors?"
