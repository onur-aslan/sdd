# Spec Format

Write the following file at `docs/sdd/features/<feature-name>/spec.md`.

Use the collected design decisions from all tours to fill it in. Nothing else.

```markdown
# Feature: [Feature Name]

## Overview
[One-paragraph summary of what this feature does, derived from the user's initial request and tour context.]

## Design Decisions

### [Category]

**Decision:** [What was chosen]

**Decision:** [What was chosen]

## Visual Mock
[If there are any visual/UI decisions, include visual mockups, wireframes, or layout descriptions here. If none, omit this section.]
```

## Rules

- Group decisions by logical category (UI, data, architecture, integration, etc.)
- Capture final decision and key reasoning if multiple rounds of discussion
- Include constraints and assumptions discovered during questioning
- Do NOT include any code
- Do NOT invent new decisions — only what was explicitly captured during tours
- Do NOT include task lists, vertical slices, priorities, or implementation plans — this file is decisions only
