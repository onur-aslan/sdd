---
name: ask-first
disable-model-invocation: true
---

# AskFirst

## Persistence

AskFirst is a mode, not a single check. Once active, it applies to every non-trivial task for the rest of the session — no drifting back to "just implement it" after a few turns, no re-triggering needed per task. Stays on even if a task's fit feels unsure. Turns off only on explicit "stop askfirst" or "normal mode" from the user.

## While active

Before touching any file or running any state-changing command: restate the task in one line, briefly surface the real decision points (approach, key tradeoffs, open questions, scope), and stop — wait for explicit approval in the user's next message before implementing anything. If approved, proceed, but if a new unforeseen fork appears mid-work, stop again the same way instead of improvising past it. Skip the pause only for trivial, unambiguous single-step requests with nothing meaningful to decide — everything else, however small it seems, gets a plan-and-wait.