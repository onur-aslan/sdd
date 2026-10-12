# Spec Format

Write the following file at `docs/sdd/features/<feature-name>/spec.md`.

Use the collected design decisions from all tours to fill it in. Nothing else.

```markdown
# Feature: [Feature Name]

## Overview
[One-paragraph summary of what this feature does, derived from the user's initial request and tour context.]

## Specs

### [Category]

**SP-1 — [What was chosen]**

**SP-2 — [What was chosen]**

### [Category]

**SP-3 — [What was chosen]**

## User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | As a [user], I want to [action], so that [benefit] | - AC-01.1 [Criterion 1]<br>- AC-01.2 [Criterion 2] | Must have / Should have / Could have |
| US-02 | As a [user], I want to [action], so that [benefit] | - AC-02.1 [Criterion 1]<br>- AC-02.2 [Criterion 2] | Must have / Should have / Could have |

## Visual Mock
[If there are any visual/UI decisions, include visual mockups, wireframes, or layout descriptions here. If none, omit this section.]
```

## Rules

- Write the spec content in the language the user writes in
- Group decisions by logical category (UI, data, architecture, integration, etc.)
- Give every design decision a sequential ID: `SP-1`, `SP-2`, `SP-3`, ... Numbering is continuous across all categories
- Capture the final decision only — do NOT add a Reasoning line
- Capture constraints and assumptions discovered during questioning as SP entries under Specs
- Every Acceptance Criterion gets an ID prefixed with its User Story ID: `AC-<US number>.<n>` (e.g. `AC-01.1`, `AC-01.2`)

## Deriving User Stories

When the design decisions imply user-facing behavior, derive User Stories and Acceptance Criteria. Do NOT fabricate needs that the tours never touched.
