---
name: handoff
description: Capture session context and decisions for another agent or follow-up session.
disable-model-invocation: true
---

# Handoff

Goal: minimize context loss after `/clear`. `/compact` summarizes context but doesn't preserve things that never made it into the repo — why a certain approach was chosen, which paths were tried and abandoned, etc. This skill writes only the information that **cannot be recovered by reading the repo** (git log, git diff, file contents) to `docs/sdd/handoff.md`.

Use `handoff-resume` skill to read the handoff file in a new session.

1. `mkdir -p docs/sdd` (create if missing).
2. Review the entire session (conversation + tool calls made).
3. Apply this filter to every candidate item:
   - **"Could I recover this by reading `git log`, `git diff`, or the files themselves?"** → Yes → don't write it.
   - **"Is this already documented in `CLAUDE.md` (project settings, user preferences, constraints)?"** → Yes → don't write it; those are already in the repo.
   - No to both → write it into handoff.md.
   - **Question asked to the user but never answered** → always include it in *Open questions*, transcribed **verbatim** (exact wording, no paraphrasing). This cannot be recovered from the repo, and the exact wording is needed so the next session can re-pose it and continue from the exact point of interruption.
4. Generate `docs/sdd/handoff.md` **from scratch** (overwrite if exists) using the template below.
5. Give the user a short confirmation: summarize what was written in 2-3 lines, then tell them it's safe to run `/clear`.

### Template

```markdown
# Handoff — <date, e.g. 2026-07-01>

## Context
- Topic/epic being worked on: <short title>

## Completed This Session
- <bullet points, referencing the relevant commit/file, one line each>

## Context Not Recoverable From the Repo

### Decisions and rationale
- <why this approach was chosen, what alternatives were considered and why they were rejected>

### Tried and abandoned approaches
- <so they aren't retried — what was tried, why it didn't work or was dropped>

### User preferences / constraints
- <preferences or constraints stated in conversation that never made it into code or comments>

### Discovered gotchas / constraints
- <environment quirks, third-party library behavior, API quirks, performance findings — anything not written into the code>

### Open questions
- <every question asked of the user in this session that still has no definitive answer — quoted verbatim, exactly as it was asked, in the order asked. Do not paraphrase or summarize. If there are none, remove this heading entirely.>

## Next Steps
1. <concrete, actionable, in order — if Open questions is non-empty, the first step must be to re-pose those questions verbatim to the user and wait for answers before starting other work>
2. ...

## Verification
- <if applicable: how to test/reproduce — only if not already documented in the repo>
```

Don't leave empty sections in the template — if there are no abandoned approaches, remove that heading entirely rather than leaving it blank.

---

## Notes

- This skill doesn't replace `/compact` — it's a manual "context transfer" step around `/clear`.
- The "Context Not Recoverable From the Repo" section is the entire point of this skill — never put anything there that `git` could already surface (file listings, diff contents, commit messages).

