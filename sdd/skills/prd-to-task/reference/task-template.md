# Task Definition Format

## Rules

- Task definition files must be self-contained — do not reference spec.md or prd.md. Copy all necessary context, decisions, and constraints into the task file
- No gap between the task files and prd. Cumulative tasks context must cover prd.
- All context must be in the task file to implement.
- If Gherkin applies: every task must have at least one happy path, one edge case, one negative path scenario — in that order
- Never invent quantitative or hardware constraint values — only use values explicitly stated in prd.md

## Location
Path: `docs/sdd/features/<feature-name>/tasks/<task-name>.md`

## Structure
```markdown
# [Task Name]

## Task-Meta
- Feature: <feature-name>
- Status: ⬜ Todo | 🔴 In Progress | ✅ Done

## Context
[2-3 sentences summarizing what this task does and why it matters. Written for executives/stakeholders who won't read the full document.]

## Design/Implementation Decisions

### [Category]

**Decision:** [What was chosen]

**Decision:** [What was chosen]

## Visual Mock
[If there are any visual/UI decisions, include visual mockups, wireframes, or layout descriptions here. If none, omit this section.]

## Implmenetation Steps
[Pre non-tdd task]
[A short implementations steps in order to do this task.]

## Out of Scopes
[Not to be done in this task]

## Scenarios

### ✅ [Happy Path]
> Story happy path — 1 only
**Given** [system state / precondition]
**When**  `[call / action + exact input]`
**Then**  `[expected result / return]`
**And**   `[if critical]`

### ⬜ [Edge Case]
> AC: PROJ-10
**Given** [precondition]
**When**  `[call + invalid / bad input]`
**Then**  `[error / signal / rejection]` 
**And**   `[if critical]`

## Conventions
- Naming:  `[test naming rule]`
- Mock:    [what is replaced with what]
- Seed:    [how initial state is set up]
```