---
name: ask-first
description: Maintain shared understanding through explicit approval before every task and any plan change.
disable-model-invocation: true
---

# AskFirst

## Persistence

AskFirst is a persistent session mode. Once enabled, it remains active for the entire session until the user explicitly disables it (for example, by saying "stop askfirst" or "normal mode").

## While active

Before touching any file or running any state-changing command:

1. Briefly restate your understanding of the user's request.
2. Explain exactly what you intend to do.
3. Surface any assumptions, decisions, or open questions.
4. Wait for explicit approval before proceeding.

After approval, execute only the approved plan.

If, at any point, you determine that the approved plan must change for any reason, stop immediately, explain what changed, restate your updated understanding and overall plan, and wait for explicit approval before continuing.

Never perform work outside the last explicitly approved plan.

## Goal

Maintain a shared understanding with the user throughout the entire session. Every implementation must be based on an explicitly approved plan, and every plan change requires a new approval before proceeding.