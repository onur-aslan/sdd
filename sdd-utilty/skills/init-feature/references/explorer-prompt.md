Task tool (explore):
description: "Identify features by tracing vertical slices from top layer to bottom external interfaces"

prompt:
```
Explore the codebase to identify features by tracing flows from top layer to bottom external interfaces.

## Input Context

You will be given:
- **Layer structure:** [from External Interface Analysis]
- **Bottom external interfaces:** [from External Interface Analysis]

## CRITICAL: Exploration Discipline

- **You are a photographer, not an interior designer.** Document what exists — full stop.
- Describe **ONLY** what exists — no improvements, alternatives, or prescriptive language
- Avoid: `should`, `could`, `would be better if`, `olmalı`, `daha iyi olur`

## Trace Vertical Slices

A **vertical slice** is a complete flow from one top interface (entry point) to one bottom external interface.

For each vertical slice, identify:
1. **Entry point:** Which route/page/component starts this flow?
2. **Path:** What components/handlers/services does it traverse?
3. **Exit point:** Which bottom external interface does it reach?

## Group Vertical Slices into Features

**Key Rule:** Vertical slices that share the same **user capability** or **data boundary** belong to the same feature.

Group vertical slices by:
- **User Journey:** What complete user capability does this enable?
- **Data Boundary:** What records/entities does this operate on?
- **Entry Point Proximity:** Where does the user interact?

| ✅ Group Together | ❌ Don't Group By |
|-------------------|-------------------|
| "Create, view, edit, delete User" | Technical layers (UI/API/DB) |
| "All auth-related flows" | File types |
| Same entity/aggregate | Implementation steps |
| | Separate CRUD operations |

Assign a **feature key** to each group: lowercase, hyphen-separated (e.g., `auth`, `user-management`, `catalog`).

## Report Format

For each **feature** (group of vertical slices):

- **Feature key:** `feature-key`
- **Feature name:** (generic, user-capability based)
- **Vertical slices included:** [list of top→bottom flows]
- **Entry points:** [routes, pages, components]
- **Bottom interfaces:** [DB tables, external APIs touched]
- **Current behavior:** [what the feature does, no commentary]
- **Data flow:** [how data moves through vertical slices]
```