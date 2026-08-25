---
name: deep-spec
description: Conducts an interview-driven design session using a multi-level zoom approach (L5:Domain to L1:Line), producing a structured spec.md under docs/sdd/features/. Use when user mentions "deep-spec", "spec-designer", or wants to design a new feature through guided questioning.
disable-model-invocation: true
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. Ask very detailed design questions. Expose hidden assumptions. Ask the questions one at a time. Do not use AskUserQuestion Tool. Do not implement, write code, or modify source files — this skill only creates the spec.

## Zoom & Tour Integration

**Zoom Levels:** L5:Domain → L4:System → L3:Component → L2:Function → L1:Line

**Tour Tracking:**
- Track `currentZoom` L{M}: {LevelName} (starts with optimal zoom level)
- Track `currentTour` number as {N} (starts at 1)
- Track `tourQuestions` count per tour
- Announce: `🎯 Tour {N} (L{M}: {LevelName}) — Question {K}`

After each design decision within a tour, continue questioning. Track current zoom level and announce it.
## Steps

**Step 1.** Announce: `🎯 Starting Tour {N} at L{M}: {LevelName}...`
Explore the codebase at current zoom level — only once per tour.

**Step 2.** Deep Think about next design question at current zoom level.
Announce: `🎯 Tour {N} (L{M}: {LevelName}) — Question {K}`

**Step 3.** Ask one design question with options, ASCII mock, and recommendation.

Format:
```
[Question text]?

A) [Option A title]
   [ASCII mock for A]

B) [Option B title]
   [ASCII mock for B]

C) [Option C title]
   [ASCII mock for C]

✅ Recommended: [A/B/C] — [one-line reason]
```

**Step 4.** After user answers, keep the decision in context (do not write to file yet).
- If there are more design questions at this zoom level → Go To Step 2
- If no more meaningful questions at this level → Proceed to Step 5 (End of Tour)

**Step 5. End of Tour.** Announce current tour and zoom level. Ask:

```
🎯 Tour {N} complete at L{M}: {LevelName}.

A) Zoom deeper — start Tour {N+1} at L{M-1} (implementation details)
B) Done — finalize spec

✅ Recommended: [A/B] — [one-line reason based on plan complexity]
```

**If user selects A (Zoom deeper):** Announce `🎯 Starting Tour {N+1} at L{M-1}...`, keep `askedQuestions` intact (do not reset), and Go To Step 2. Probe only new, deeper questions that have not been asked before — never re-ask a question from an earlier tour.

**If user selects B (Done):** Read [spec-format.md](spec-format.md) and write `docs/sdd/features/<feature-name>/spec.md` directly with the collected decisions.

---

## Next Step

**→ `/spec-to-prd`**