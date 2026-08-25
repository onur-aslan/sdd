Task tool (general-purpose):
description: "Writing PRD for `<feature>`..."

prompt:
```
You are a PRD Writer. Your task is to write a Product Requirements Document (PRD) for a single feature.

## Input Context

You will be given:
- **Feature Name:** [feature name from codebase scan]
- **Feature Key:** [feature key from codebase scan]
- **Feature Description:** [description from codebase scan - current behavior, entry point, data flow]
- **Current Codebase State:** [explore and understand the current state]

## Your Task

Write a comprehensive PRD following the format at [prd-format.md](prd-format.md).

## Output

Write the PRD to: `docs/sdd/features/[feature-key]/prd.md`
```