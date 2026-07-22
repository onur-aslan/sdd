# Spec to PRD Mapping Guide

Maps `spec.md` design decisions to PRD sections.

---

## Mapping Table

| spec.md Element | → | PRD Section | Notes |
|-----------------|---|-------------|-------|
| `# Feature: [Name]` | → | PRD Title | Use as `# PRD: [Feature Name]` |
| `## Overview` | → | Section 1: Executive Summary | Condense to 2-3 sentences, remove jargon |
| Design decisions (problem context) | → | Section 2: Problem Statement | Extract pain points and impact |
| Design decisions (goals) | → | Section 3: Goals & Objectives | Convert to measurable outcomes |
| Design decisions (functional) | → | Section 6: Functional Requirements | One FR per distinct capability |
| Design decisions (technical) | → | Section 9: Technical Considerations | Translate to stakeholder-friendly language |
| Design decision rationales | → | Throughout | Use as context for why requirements exist |
| `## Visual Mock` | → | Section 8.1: Wireframes / Mockups | Copy or reference |
| Trade-offs mentioned | → | Section 9.2: Technical Constraints | Document as constraints |
| Constraints/Assumptions | → | Section 9.2: Technical Constraints | Or Section 3.2: Non-Goals if scope-related |

---

## Inference Rules

When spec.md doesn't explicitly state something, infer from context:

### Deriving User Stories
```
IF spec mentions "users need to X" or "allows Y"
THEN create user story: "As a [relevant user], I want to [action], so that [benefit from rationale]"
```

### Extracting Acceptance Criteria
```
FOR EACH design decision rationale:
  IF it mentions a condition or behavior
  THEN convert to: "- [System] must [behavior]"
```

### Identifying Success Metrics
```
IF spec explicitly mentions a problem like "slow", "error-prone", "manual"
THEN propose metric for Section 4:
  - Baseline: current state (may need stakeholder input)
  - Target: improved state
  - Method: how to measure
ELSE
  Leave Section 4 as "TBD - requires stakeholder input"
```

### Prioritization (MoSCoW)
```
P0 (Must have): Core feature behavior without which feature doesn't work
P1 (Should have): Important but feature still delivers value without it
P2 (Could have): Nice to have, deferable to future iterations
```

---

## spec.md Pattern Recognition

### Decision Categories

| Category Keywords | Map To |
|-------------------|--------|
| "UI", "frontend", "user sees", "display", "wireframe", "mockup" | Section 8.1: Wireframes / Mockups |
| "content", "messaging", "copy", "tone", "localization" | Section 8.2: Content & Messaging |
| "goal", "objective", "outcome" | Section 3: Goals |
| "metric", "measure", "baseline", "target" | Section 4: Success Metrics |
| "user", "story", "as a" | Section 5: User Stories |
| "must", "required", "need" | Section 6: Functional Requirements |
| "performance", "latency", "throughput" | Section 7.1: Performance |
| "auth", "permission", "access" | Section 7.2: Security |
| "reliability", "availability", "uptime", "recovery" | Section 7.3: Reliability & Availability |
| "scale", "load", "concurrent" | Section 7.4: Scalability |
| "WCAG", "a11y", "screen reader" | Section 7.5: Accessibility |
| "API", "integration", "external" | Section 9.1: Integration Points |
| "constraint", "limitation", "trade-off" | Section 9.2: Technical Constraints |

---

## Gap Detection

Report these gaps to the user:

| Missing from spec.md | PRD Section Affected | Action |
|----------------------|---------------------|--------|
| No problem context | Section 2 | Mark "TBD - add problem statement to spec.md" |
| No goals/outcomes | Section 3 | Mark "TBD - define success metrics" |
| No success metrics/KPIs in spec | Section 4 | Mark "TBD - requires stakeholder input" (do NOT fabricate) |
| Only technical decisions | Section 5, 6 | Infer from capabilities, flag for review |
| No constraints | Section 9.2 | Leave blank with "None identified" |

---