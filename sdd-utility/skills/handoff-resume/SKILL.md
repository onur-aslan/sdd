---
name: handoff-resume
description: Resume work from a previous handoff document and recover session context.
disable-model-invocation: true
---

# Handoff Resume

Goal: quickly restore session context by reading `docs/sdd/handoff.md` at the start of a new session.

1. Read `docs/sdd/handoff.md`.
2. Absorb the content silently into context — don't dump the raw file back at the user.
3. Give a short confirmation summary (3-5 lines): what the last state was, which decisions/constraints still apply, what the next step is.
4. State that you're ready to continue from the first item in "Next Steps", then wait for the user's confirmation before doing anything else — never continue on your own.
5. Delete `docs/sdd/handoff.md`.
