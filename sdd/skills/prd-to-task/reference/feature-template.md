# Feature Format
## Location
Path: `docs/sdd/features/<feature-name>/feature.md`

## Structure
```markdown
# Execution Plan

## Task Order

| # | Task | File | Status | Depends On |
|---|------|------|--------|------------|
| 1 | [Task name] | [task1_{task-name}.md](tasks/task1_{task-name}.md) | Pending | — |
| 2 | [Task name] | [task2_{task-name}.md](tasks/task2_{task-name}.md) | Pending | Task 1 |
| 3 | [Task name] | [task3_{task-name}.md](tasks/task3_{task-name}.md) | Pending | Task 1 |
| 4 | [Task name] | [task4_{task-name}.md](tasks/task4_{task-name}.md) | Pending | Task 2, Task 3 |

## Notes
[Sequencing decisions that are not obvious from the dependency graph. If empty, omit this section.]
```