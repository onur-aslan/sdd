---
name: spec-to-prd
description: Converts spec.md files into PRD (Product Requirements Document) format. Use when user says "spec-to-prd", "convert to PRD", "write PRD from spec", or wants to generate a product requirements document from an existing feature spec.
---

# Spec to PRD Converter

Transforms `spec.md` (technical specification with design decisions) into `prd.md` suitable for stakeholder review and product planning.

---

## Workflow

### Step 1: Locate and Read spec.md

**Announce:** "Step 1: Reading spec.md..."

Find and read `docs/sdd/features/<feature-name>/spec.md`. Extract:
- Feature name (from `# Feature: [Name]`)
- Overview/summary
- All design decisions with rationales
- Any visual mockups or UX notes

**Validation:** If spec.md does not exist, exit with error: "spec.md not found at docs/sdd/features/<feature-name>/spec.md"

---

### Step 2: Analyze for PRD Content

**Announce:** "Step 2: Analyzing spec for PRD content..."
- Explore the repo to understand the current state of codebase, if you haven't already.
- Read [references/mapping-guide.md](references/mapping-guide.md). Apply the mapping table and inference rules to extract PRD content from spec.md design decisions.

---

### Step 3: Generate prd.md

**Announce:** "Step 3: Generating prd.md..."

- Read [references/prd-format.md](references/prd-format.md). Use strictliy this format and  write `docs/sdd/features/<feature-name>/prd.md` following the template structure.

---

### Step 4: Report Output

**Announce:** "Step 4: PRD generation complete"

Report to the user:
1. Path to generated PRD: `docs/sdd/features/<feature-name>/prd.md`
2. Sections that need stakeholder input (marked as TBD)
3. Any gaps where spec.md lacked sufficient detail for PRD completeness

---

## Edge Cases

### Missing spec.md
**Error:** "spec.md not found. Run `deep-spec` or create spec.md at `docs/sdd/features/<feature-name>/spec.md` first."

### Incomplete spec.md
If spec.md exists but lacks sufficient detail:
- Generate PRD with all sections
- Mark incomplete sections clearly with "TBD - requires spec.md update"
- Report specific gaps: "Section 7.2 (Security) could not be populated - no security-related design decisions found in spec.md"

### Multiple features in one spec.md
If spec.md contains multiple distinct features:
- Report: "spec.md appears to contain multiple features. Consider splitting into separate spec.md files per feature for cleaner PRD generation."
- Generate a single PRD but note this in the report

---

## Next Step

**→ `/prd-to-task`**
