# Spec Format

Generate the following file at `docs/sdd/features/<feature-name>/spec.md`.

Reverse-engineer the content from the existing codebase. Capture only what the code actually does.

```markdown
# Feature: [Feature Name]

## Overview
[One-paragraph summary of what this feature does, derived from the codebase scan.]

## Specs

### [Category]

**SP-1 — [What the code does / chose]**

**SP-2 — [What the code does / chose]**

### [Category]

**SP-3 — [What the code does / chose]**

## User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | As a [user], I want to [action], so that [benefit] | - AC-01.1 [Criterion 1]<br>- AC-01.2 [Criterion 2] | Must have / Should have / Could have |
| US-02 | As a [user], I want to [action], so that [benefit] | - AC-02.1 [Criterion 1]<br>- AC-02.2 [Criterion 2] | Must have / Should have / Could have |

## Visual Mock
[If there are any visual/UI decisions, include visual mockups, wireframes, or layout descriptions here. If none, omit this section.]
```

## Rules

- Group decisions by logical category (UI, data, architecture, integration, etc.)
- Give every design decision a sequential ID: `SP-1`, `SP-2`, `SP-3`, ... Numbering is continuous across all categories
- Capture the final decision only — do NOT add a Reasoning line
- Include constraints and assumptions discovered during the codebase scan
- Do NOT include any code
- Do NOT invent behavior — only what the codebase actually does
- Do NOT include task lists, vertical slices, priorities, or implementation plans — this file is decisions only
- Every Acceptance Criterion gets an ID prefixed with its User Story ID: `AC-<US number>.<n>` (e.g. `AC-01.1`, `AC-01.2`)
