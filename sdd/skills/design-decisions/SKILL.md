---
name: design-decisions
description: Collects a project's UI/UX decisions from the user through an HTML preview with selectable alternatives, then records and locks them in DESIGN.md (Layer 1) and design/pages/<slug>.md (Layer 2). Use for a new project, a new screen, a redesign, or when DESIGN.md is missing; also when a locked design decision needs to change. Triggers - design system, theme, color, typography, layout, screen layout, user flow, design decision, DESIGN.md, UI choice, style choice. Never guess design decisions; ask through this skill.
disable-model-invocation: true
---

# design-decisions

The agent does not make UI/UX decisions; the user does. This skill gathers decisions in an HTML preview, writes the choices to `DESIGN.md` (Layer 1) and `design/pages/<slug>.md` (Layer 2), and locks them. Locked files change only by invoking this skill again or by approving a `ui-prompt` exit review.

## Layers

Decisions are collected in two rounds. Each round is one HTML preview, asked all at once.

- **Layer 1 — Global:** decisions that bind the whole project. Locking it creates `DESIGN.md`, which stays the single entry point.
- **Layer 2 — Screens and flows:** per-screen layout, hierarchy, data presentation, forms, flows. Asked after Layer 1 is locked, and its previews are drawn with the locked Layer 1 tokens. Each scope is written to its own locked file under `design/pages/<slug>.md`; `DESIGN.md` holds only the index that links them.

After Layer 1 locks, continue to Layer 2 in the same run unless the user said "global only".

## Invocation

`/design-decisions [arguments]` — free-text arguments select the round:

- **None** — full flow: Layer 1 if `DESIGN.md` is missing or unlocked, then Layer 2; if locked, ask what to change and re-ask only that.
- **Screen or pattern names** (e.g. `chat screen`) — a Layer 2 round scoped to those Step 1 screens: no page file yet → new round and page file; page file exists → list its decisions and re-ask only the ones the user picks (with "Current choice" cards and 3 new alternatives); no `DESIGN.md` → Layer 1 first (`global only` stops there); several matches or none → one clarifying question, never guess.
- **`global only`** — Layer 1 and stop. **`re-ask D03,D05`** — exactly those IDs.

Scoped rounds use `.design/choices-k2-<slug>.json` → `choose-k2-<slug>.html` + `choices-k2-<slug>.selections.txt`; one round per scope (name a pattern to cover several screens); IDs continue across rounds (highest `Dxx` in `DESIGN.md` + `design/pages/`); Step 6 writes only the asked scopes' page files.

## Step 1 — Scan the project

Before asking anything, detect the stack and read the existing design traces (theme/tailwind config, CSS variables, fonts, component library, icon set), the screens/routes with their real content (titles, labels, sample data), the product description, and any existing style guide. If `DESIGN.md` and `design/pages/` exist, read them too and note the existing slugs. Summarize as "Current state" for `DESIGN.md`.

If the project is empty and the product is unclear, ask one short question: product, audience, platform. Nothing else.

## Step 2 — List the decisions

Scope is unlimited. The catalogs below are starting points: pick what the scan makes relevant, skip what the project doesn't have, add project-specific decisions. IDs (`D01`, `D02`…) continue across rounds.

**Layer 1 (`scope: global`):** visual direction · color (primary/accent, neutrals, semantic, theme mode) · typography · spacing and density · shape (radius, borders, elevation) · app shell and grid · navigation pattern and its mobile behavior · component language · icons and imagery · motion · data visualization (if present) · tone of voice, microcopy, localization (RTL)

**Layer 2 (`scope: <screen | screen type>`):** screen skeleton · information hierarchy and primary action placement · list/data presentation (table/card/list, pagination, mobile equivalent of tables) · form layout · detail/edit pattern (modal, side panel, page) · critical flows (onboarding, auth, checkout) · empty/error/loading layout · content layout

With many screens (more than ~8), group them by pattern and ask per pattern. A screen that must differ goes in the note field, and the skill opens a separate decision for it.

For Layer 2, `scope` is also the file grouping: decisions with the same `scope` land in the same `design/pages/<slug>.md` (lowercase ASCII kebab-case; normalize non-ASCII letters to their ASCII equivalents before slugging). Reuse the slug of an existing file for the same scope; on a collision add `-2`, `-3`.

**Fixed baseline (never asked; every alternative complies):** text contrast ≥ 4.5:1, touch targets ≥ 44px, visible focus, `prefers-reduced-motion` support.

## Step 3 — Write alternatives

- At least **3** genuinely different alternatives per decision. Add a 4th or 5th only if it is strong; don't pad.
- If the project already implements the decision, add "Keep current" on top of the 3.
- "Other (my own description)" and a free-text note are added by the template; don't add them yourself.
- **No steering:** no "recommended", "popular" or "best" labels, nothing preselected, no value-laden words ("modern", "sleek", "clean"). Use neutral names (A, B, C…) with short descriptive text, and an order that implies no preference.

## Step 4 — Build and serve the preview

Don't write HTML. Write the round's decisions to `.design/choices-k<layer>.json` (or `.design/choices-k2-<slug>.json` for a scoped round; schema, sample content, token names and wireframe classes: `references/choices-schema.md`; read it now), then serve (`<skill-dir>` is the folder containing this SKILL.md; use `python` or `py -3` if `python3` doesn't exist):

```
python3 <skill-dir>/scripts/build_preview.py serve .design/choices-k<layer>.json
```

Run it in the background (Bash tool `run_in_background`). It fills the fixed template `assets/choose-template.html`, writes `.design/choose-k<layer>.html` (scoped round: `.design/choose-k2-<slug>.html`), serves that preview on `127.0.0.1` under a random token, opens the browser and waits (default 1800s; `--timeout`, `--port`, `--no-open`, `-o`, `--only`, `--design-md` as on `build`). It rejects fewer than 3 alternatives and warns on steering words, missing `sample` and contrast below the baseline: treat every warning as a defect, fix it and rerun.

The template guarantees nothing is preselected, shows progress, has a note field per decision, a **Send selections** button and a **Copy selections** fallback, and works on mobile and in light/dark. For Layer 2 the script reads the locked tokens from `DESIGN.md` itself.

The user picks the alternatives and presses **Send selections**: the choices are posted back to the running server, which writes `.design/choices-k<layer>.selections.txt` and exits. That exit is the signal that the round is answered — never ask the user to paste anything.

If the preview is opened as a plain file instead (no server, e.g. shared over chat), **Send** is hidden: use **Copy selections** and paste the block, then save it yourself for `check`. If Python is unavailable, replace `__CHOICES_JSON__` in a copy of the template with the JSON yourself and use the Copy path.

Previews must use the project's real content (`sample`, `html` fields), never placeholder text. In chat give one short instruction: "Choose, press Send selections."

## Step 5 — Validate

`serve` already wrote `.design/choices-k<layer>.selections.txt` (scoped round: `.design/choices-k2-<slug>.selections.txt`; with `--only`: `...-partial.selections.txt`). Run:

```
python3 <skill-dir>/scripts/build_preview.py check .design/choices-k<layer>.json .design/choices-k<layer>.selections.txt
```

If the user used the Copy fallback, save the pasted block to a file and pass that path instead.

It reports `missing` (unanswered, across all decisions: answers are saved in `.design/choices-k<layer>.resolved.json` and merged across rounds), `problems` (unknown alternative, `OTHER` without a description, project/layer mismatch), each resolved choice with its rejected alternatives, and the merged `tokens`. Then:

- Anything missing or a problem: don't lock. Serve only those decisions (`serve ... --only D03,D05`), have the user answer, and run `check` on the new `-partial.selections.txt`.
- Conflicting choices (e.g. dark-only theme + light pastel palette) are your judgment: show the conflict and re-ask the related decisions. Don't say which to pick.

## Step 6 — Write DESIGN.md, page files and lock

When every decision in the round is answered:

- **Layer 1:** read `references/design-md-template.md` and write `DESIGN.md` at the project root with it (created in Layer 1, updated in Layer 2) and `status: locked`. Take choices, values, rejected alternatives, notes and the Tokens block from the `check` output (`OTHER` answers have no `vars`: derive their values from the description).
- **Layer 2:** read `references/page-md-template.md`. Group the resolved decisions by `scope` and write one `design/pages/<slug>.md` per scope (create the directory if needed; reuse the slug of an existing file for the same scope), each `status: locked`. Then update `DESIGN.md`: fill the Layer 2 index table (scope, pages, file link, decision IDs, version), set `layers: [1, 2]`, bump `version`, and add one changelog row per page written. Never copy the Layer 2 decisions into `DESIGN.md`.
- **Delta:** after the files are written, emit `design/deltas/delta-<round>.json` (round label from the choices file: `choices-k2-chat.json` → `delta-k2-chat.json`; schema and rules: `references/delta-schema.md`) with each decision's `fingerprint` from `check`; summarize the change in 3–5 lines for the user.
- Any round: bump `version` and `updated` whenever `DESIGN.md` changes. **Don't change project code**; apply the design only if the user asks.

## Step 7 — CLAUDE.md / AGENTS.md reference

Add the block below to `CLAUDE.md` and `AGENTS.md` if they exist; if neither exists, create both containing only this block. If the block is already there (by its markers), update it instead of duplicating. Tell the user what you added.

```
<!-- design-decisions:start -->
## UI/UX decisions
- Before any work that needs a new screen, component, or style decision, read `DESIGN.md`.
- Layer 1 is binding everywhere. For a specific screen, also read the page file linked from the Layer 2 index; for its scope it overrides `DESIGN.md`.
- If `status: locked`, the decisions are binding. Don't change color, typography, spacing, shape, component style, or layout on your own, and don't edit `DESIGN.md` or any `design/pages/` file by hand.
- If a UI decision isn't covered by `DESIGN.md` or the screen's page file (including a screen with no page file), don't guess: stop, tell the user, and invoke the `design-decisions` skill.
- If `DESIGN.md` doesn't exist, run the `design-decisions` skill before starting UI work.
<!-- design-decisions:end -->
```

## When `DESIGN.md` already exists

Read it — and the page files its index links — first, then re-ask only what changes: the decisions the user names, plus dependent ones they choose to include (palette → theme mode and semantic colors; density or navigation → screen layouts), or a new Layer 2 round with new IDs for new screens. Each re-asked decision gets a "Current choice" card plus at least 3 new alternatives.

On save:

- **Layer 1 change:** update `DESIGN.md`, bump `version`/`updated`, add a changelog row `Dxx: old → new`, move the old choice to "Rejected".
- **Layer 2 change:** update that scope's `design/pages/<slug>.md`, bump its `version`, add a row to its changelog, and add a `DESIGN.md` changelog row naming the page.
- **New screen:** new page file plus a new index row in `DESIGN.md`.
- Keep every written file `status: locked`. If an older `DESIGN.md` still holds inline Layer 2 sections, move them into page files during the next round (only through this skill) and replace them with index rows.
