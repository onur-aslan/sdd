---
name: init-feature
description: Initialize a new feature with the required structure and starting artifacts.
disable-model-invocation: true
---

Scan the codebase to identify existing features and spawn subagents to write specs for each.

---

## Workflow

### Step 1: External Interface Analysis

**Announce:** "Step 1: Analyzing external interfaces..."

Analyze the codebase to identify architectural layers and external interfaces. Show layers as ASCII diagram and list all bottom external interfaces.

---

### Step 2: Discover Features (Explore Agent)

**Announce:** "Step 2: Discovering features..."

Spawn an Explore subagent with the prompt from [references/explorer-prompt.md](references/explorer-prompt.md).

Pass the layer structure and bottom external interfaces from Step 1 as input context.

Wait for the Explore agent to complete.

---

### Step 3: Select Features

Show the user the list of identified features.

Process all identified features. If the user specified particular features when invoking this skill, process only those.

---

### Step 4: Spawn Spec Writer Subagents

**Announce:** "Step 4: Spawning spec writer subagents..."

For each selected feature:

1. Spawn an Explore subagent with the prompt from [references/spec-writer-prompt.md](references/spec-writer-prompt.md)
2. Replace `[feature name]`, `[feature key]`, and `[feature description]` placeholders with actual values from Step 3
3. Run all subagents in parallel

Wait for all subagents to complete.

---

### Step 5: Report Results

**Announce:** "Step 5: Spec generation complete"

Report to the user.
