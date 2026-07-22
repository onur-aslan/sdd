---
name: ui-heuristic-click-audit
disable-model-invocation: true
---

# UI Heuristic Click Audit

Three-phase pipeline: **discover** every clickable element → **capture**
post-click screenshots → **score** each screenshot against a fixed
checklist → **aggregate** into one report with fix suggestions.

Requires: subagent/Task capability (Claude Code or Cowork). Also requires
`playwright-mcp` **unless** the user already supplies a ready screenshot
directory, in which case Steps 1-2 are skipped and no browser tool is
needed.

## Before starting

**Check for existing screenshots first:**
- Look in `docs/ui-audit/images/` for any `.png` or `.jpg` files.
- **If screenshots exist:** Skip Step 1 and Step 2 entirely. Go straight to Step 3, scoring every image file found in that directory.
- **If no screenshots exist:** Ask the user for:
  - Base URL of the running app (must already be running / reachable)
  - Pages/routes to include or exclude

Output directory structure:
```
docs/ui-audit/
├── discovered_buttons.json   (skip if screenshots were provided)
├── images/                   (screenshots directory)
├── reports/
└── ui_audit_report.md        (final deliverable)
```

If skipping to Step 3 (screenshots already exist), build the input list yourself:
for each image file in `docs/ui-audit/images/`, create an entry:
`{id: <filename without extension>, screenshot_path: <path>, label: <filename>, page_url: null, source_file: null}`.
Use this list as the input to Step 3.

## Step 1 — Discover clickable elements (one explore subagent)

**Skip this entire step if screenshots already exist in `docs/ui-audit/images/`.**
Go directly to Step 3.

Spawn **one** subagent (explore/general-purpose type) with this task:

> Scan the project codebase (components, pages, routes) and the rendered
> app if needed, and produce a JSON list of every clickable element:
> buttons, links styled as buttons, icon buttons, nav items, menu items.
> For each, capture: `id` (short slug), `label` (visible text or
> aria-label), `page_url` (route it appears on, relative to base URL),
> `selector_hint` (text content, aria-label, or data-testid — whatever is
> most reliable to click with Playwright), `source_file` (file:line if
> found in code, else null).
> Write the result to `docs/ui-audit/discovered_buttons.json` as a JSON array.

Wait for this subagent to finish before proceeding. If it finds 0 buttons,
stop and report that to the user rather than continuing.

## Step 2 — Click + screenshot each button (sequential subagents)

**Skip this entire step if screenshots already exist in `docs/ui-audit/images/`.**
Go directly to Step 3.

**Must run sequentially, one button at a time — never in parallel.** All
buttons share the same browser session/page state via playwright-mcp;
parallel subagents would race on the same browser and corrupt each
other's state.

For each entry in `docs/ui-audit/discovered_buttons.json`, in order, spawn a
general-purpose subagent with this task (fill in the button's fields):

> Using the playwright-mcp tool:
> 1. Navigate to `{base_url}{page_url}`.
> 2. Locate the element matching `{selector_hint}`.
> 3. Click it.
> 4. Wait briefly for the UI to settle (animations, network requests).
> 5. Take a screenshot and save it as `docs/ui-audit/images/{id}.png`.
> 6. Note in one sentence what happened after the click (navigated to new
>    URL, opened modal, opened external link, no visible change, error).
> 7. If the click navigated to a new page or opened an external site,
>    that's fine — screenshot the resulting state as-is.
> 8. Return a small JSON: `{id, screenshot_path, result_note, resulting_url}`.
>
> If the element can't be found or clicked, still record it with
> `result_note: "click failed: <reason>"` and skip the screenshot — do
> not stop the overall run.

Append each result to `docs/ui-audit/discovered_buttons.json` (add the result
fields to that button's entry) so progress is resumable.

**Resumability**: before spawning a subagent for a given button, check if
`docs/ui-audit/images/{id}.png` already exists — if so, skip it (already
done). This lets the whole pipeline be safely re-run after an
interruption.

## Step 3 — Score each screenshot (sequential subagents)

Read `references/checklist.md` once yourself (or pass its content into
each subagent's prompt) — it defines the 8 scorable criteria and the
scoring format.

For each screenshot in `docs/ui-audit/images/`, sequentially spawn a
general-purpose subagent with this task:

> View the image at `{screenshot_path}`. Score it against the checklist
> below. For each of the 8 criteria give `score` (0-10), `confidence`
> (high/medium/low), `issues` (bullets), and `fix` (concrete suggestion,
> referencing `{source_file}` if given). Compute `overall` as the average
> of the 8 scores. Identify the single lowest-scoring criterion as
> `top_issue`. Write the result as JSON to
> `docs/ui-audit/reports/{id}.json` with shape:
> `{id, label, page_url, overall, top_issue, criteria: [...]}`.
>
> [paste full checklist.md content here]

Screenshots can be scored sequentially or in small batches — unlike Step
2 there's no shared browser state, so this step can be parallelized if
the environment supports it well. Default to sequential unless the user
asks for speed and the environment handles parallel subagents reliably.

## Step 4 — Aggregate final report

After all `docs/ui-audit/reports/{id}.json` files exist, compile
`docs/ui-audit/ui_audit_report.md` yourself (no subagent needed — this is
simple aggregation):

```markdown
# UI Heuristic Audit Report

Generated: {date}. {N} clickable elements audited.

## Summary table
| Button | Page | Overall | Top issue |
|---|---|---|---|
| ... | ... | 6.4 | Color Contrast |

(sorted worst-to-best by overall score)

## Buttons that failed to click
- {id}: {result_note}

## Detail per button
### {label} ({page_url})
![screenshot](images/{id}.png)
Overall: {overall}/10

| Criterion | Score | Confidence | Issue | Fix |
|---|---|---|---|---|
| Visual Hierarchy | 7 | high | ... | ... |
| ... | | | | |

---
```

Sort the summary table worst-to-best so the user sees the biggest
problems first. Present the final report path to the user when done.

## Notes

- Out-of-scope heuristics (accessibility internals, form validation,
  loading/empty states, multi-page consistency) are deliberately excluded
  from scoring — see the note at the bottom of `references/checklist.md`.
  Mention this limitation once in the final report, don't repeat it per
  button.
- Keep a TodoList tracking buttons through discover → screenshot → score
  so long runs (dozens of buttons) don't lose track of progress.
