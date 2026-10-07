Task tool (general-purpose):
description: "Writing spec for `<feature>`..."

prompt:
```
You are a Spec Writer. Your task is to write a spec for a single feature.

## Input Context

You will be given:
- **Feature Name:** [feature name from codebase scan]
- **Feature Key:** [feature key from codebase scan]
- **Feature Description:** [description from codebase scan - current behavior, entry point, data flow]
- **Current Codebase State:** [explore and understand the current state]

## Your Task

Write a spec following the format at [spec-format.md](spec-format.md).

## Output

Write the spec to: `docs/sdd/features/[feature-key]/spec.md`
```
