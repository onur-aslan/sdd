# Design

## Overview

**Technical Paper** is the visual system for `sdd studio`. It treats the product as a working document and a calibrated instrument: cool paper, ink, hairline rules, tabular numbers, and a dark inset reserved for literal machine output. The shell is quiet so the run is loud. The design is deliberately light — most operator tools default to dark, but this one is read and audited as much as it is watched, and long reports, diffs, and plans are easier to trust on paper.

## Research

- **Evil Martians, "Devs in mind 2025"** — developer tools have no happy path; users move between panels constantly. Pack related controls into one panel, keep secondary actions in panel footers, expect narrow/windowed use, style scrollbars, and do not spend chrome on a logo.
- **Warp's design system** — the terminal is the centre of gravity, expressed as a distinct block inside a larger IDE-like shell. Machine output deserves its own material, not the same surface as configuration.
- **GitHub + Mermaid documentation practice** — diagrams inside Markdown are expected to render inline while the source remains recoverable. A renderer that hides the fence entirely makes debugging harder.
- **Implication for this product** — a paper workbench with a dark inset for raw bytes; the queue, the plan, and the live record share one reading axis; settings live in a drawer so the work surface stays intact.

## Theme

- Mode: light shell, dark machine inset.
- Material: cool paper, not cream. Chroma is near zero and tinted toward blue, never toward warm.
- Structure: flat sheets separated by 1px rules. No card-inside-card, no floating panels on gradients.
- Character: a technical manual / lab notebook that happens to be alive.
- Colour strategy: **restrained** — ink and paper carry the surface; Prussian blue is the only action colour; vermilion is reserved for attention; moss for confirmed success.

## Colour

All values are OKLCH. Tokens live in `studio/styles.css`.

| Token | Value | Role |
|---|---|---|
| `--paper` | `oklch(0.973 0.003 240)` | App background, sheets |
| `--paper-2` | `oklch(0.952 0.004 240)` | Recessed rows, rails |
| `--paper-3` | `oklch(0.925 0.005 240)` | Hover, selected row |
| `--ink` | `oklch(0.205 0.015 245)` | Primary text |
| `--ink-2` | `oklch(0.34 0.013 245)` | Secondary text |
| `--muted` | `oklch(0.445 0.012 245)` | Labels, metadata (≥4.5:1) |
| `--line` | `oklch(0.865 0.006 245)` | Hairline rules |
| `--line-strong` | `oklch(0.60 0.010 245)` | Input and control borders |
| `--accent` | `oklch(0.395 0.095 248)` | Primary action, active state |
| `--accent-soft` | `oklch(0.940 0.018 248)` | Selection tint |
| `--signal` | `oklch(0.480 0.170 032)` | Attention, human review |
| `--success` | `oklch(0.440 0.090 155)` | Fixed / done |
| `--warn` | `oklch(0.460 0.110 075)` | Cancelled / caution |
| `--term` | `oklch(0.185 0.012 245)` | Terminal surface |
| `--term-ink` | `oklch(0.880 0.015 150)` | Terminal text |
| `--term-muted` | `oklch(0.620 0.015 245)` | Terminal metadata |

Rules:
- Body text ≥ 4.5:1; large text ≥ 3:1.
- Do not use vermilion for destructive-only actions; it marks *attention*, not danger.
- Never signal state with colour alone: pair the dot with a word.

## Typography

| Role | Stack | Use |
|---|---|---|
| UI sans | Segoe UI Variable Text / system-ui | Controls, labels, body |
| Mono | Cascadia Code / ui-monospace | Keys, counts, paths, logs, timestamps |
| Serif | Iowan Old Style / Palatino / Georgia | Page titles, report prose, the wordmark |

- Body: 13.5px / 1.55, max 72ch for prose.
- Page title: `clamp(26px, 3vw, 34px)` serif, line-height 1.08.
- Sheet title: 15px sans semibold.
- Metadata: 11px mono, uppercase only for short state words.
- All counts and durations use `font-variant-numeric: tabular-nums`.
- Headings use `text-wrap: balance`; prose uses `text-wrap: pretty`.

## Layout

```
topbar: brand · workspace ───────────────── local · jira · version
rail │ workbench
     │  page head (serif title + scope meta)
     │  ┌ queue (380–420px) ┬ run (fluid) ┐
     │  │ bugs + plan       │ results      │
     │  │ actions           │ terminal     │
     │  └───────────────────┴──────────────┘
```

- Topbar 56px, rail 208px, page gutter `clamp(16px, 3vw, 36px)`.
- Workbench: `grid-template-columns: minmax(340px, 400px) minmax(0, 1fr)`.
- ≤ 1040px: rail becomes a horizontal workflow bar; workbench becomes one column, queue first.
- ≤ 640px: topbar metadata collapses, actions become full-width, dialog becomes full-screen.
- Settings is a right-side modal drawer, 480px wide, sticky footer.
- Interview sessions (Enhancement, Feature) drop the two-sheet axis: the page head stays and the session fills the rest of the viewport as one column, `calc(100vh - topbar - head)` with a floor that yields on short viewports, so the page keeps a single scrollbar. A centred 780px reading column holds the conversation on paper; the composer is docked beneath it, so the question, the answer field, and the final plan stay in one frame. At ≤900px the session takes `min(78vh, 720px)`; at ≤640px `74vh`, the turn label moves above its body, and the agent name drops out of the bar.
- Rules over boxes: a sheet has no shadow and no radius; only the raw inset, inputs, the approval plate, and the dialog have surfaces.

## Components

- **Buttons** — 32px tall, 3px radius, 1px border. Primary is solid Prussian blue. Secondary is paper with a strong hairline. Quiet is text-only. Destructive outline is vermilion, never filled.
- **Fields** — label 12px sans; input 34px tall on paper, 1px `--line-strong`, 3px radius. Focus is a 2px accent ring with offset. No placeholder-as-label.
- **Checkbox** — 15px square, 1px strong border; checked is accent fill with a drawn check. 44px hit area via the row.
- **Bug row** — checkbox, mono key, summary, mono priority. Selected row gets `--accent-soft`; hover gets `--paper-3`. Rows are divided by hairlines, not cards.
- **Status stamp** — 1px outline, 2px radius, 10.5px mono uppercase, with a 5px dot. Variants: idle, running, done, failed, cancelled.
- **Ruler** — a 10px tape with tick marks; progress is a solid accent fill. The label uses tabular numerals.
- **Terminal** — dark inset, 4px radius, 1px inner border, 11.5px mono, 1.6 line-height, styled scrollbar, top bar with a live dot and a copy action.
- **Raw inset** — the only dark surface: literal bytes, 4px radius, 1px inner border, 11.5px mono, 1.6 line-height, styled scrollbar. Reached from the session's **Raw** segment.
- **Session conversation** — a conversation on paper, not a chat UI: a centred ~780px column of hairline-divided turns, never bubbles or avatars. A human turn is a tinted `--paper-2` block with a small mono `YOU` label; an agent turn is plain document prose under a top hairline; a system note is a dashed signal-tinted plate. Headings are serif, prose sans, code mono, quotes carry a Prussian left rule. **Rich / Raw** is a real material switch, not a tint: Rich is the paper conversation, Raw is the dark inset. Mermaid diagrams render light on paper with paper/ink `themeVariables`; the renderer is local, so the reader works offline. Rich content is not a live region; only the status is announced.
- **Finish** — a quiet toolbar action beside Stop, enabled only while the agent waits. It closes a session whose last reply is the final artifact, so the end of an interview is a human decision rather than a guess about the prose. A feature session also ends on its own when `docs/sdd/features/<feature>/spec.md` is written.
- **Approval plate** — a vermilion-hairline plate inside the conversation for a Claude Code `PermissionRequest`: the tool and its argument in mono, one line of context, and **Allow once** / **Deny**. It is the one place a button belongs in the transcript, because it is a security decision, not an answer; interview answers use the composer only.
- **Session input** — a docked composer under the conversation: an accent `›` caret, an auto-growing mono textarea (36px, growing to 200px), and the send button. It is disabled while the agent works, and the placeholder carries the state ("Waiting for the agent…"). When the session ends it re-enables with "Start another …", so the same field starts the next one and the finished conversation stays on screen until it does.
- **Settings drawer** — paper, full height, 1px left rule, sections separated by rules, sticky header/footer. Native `<dialog>` for focus handling.
- **Interview prompt** — a run-level question from a sweep, shown as a bottom-right margin note with a rule at the top, not a chat bubble. Choices are full-width rows. The Enhancement and Feature interviews do not use it; they ask inside the session conversation.
- **Empty state** — a serif statement, one sentence of plain explanation, and a single next action. No illustration.

## Motion

- Easing: `cubic-bezier(0.16, 1, 0.3, 1)`.
- Durations: 140ms (hover/focus), 220ms (view switch, dialog), 320ms (drawer settle).
- View switch: 4px rise + fade. Drawer: 24px slide + fade. No bounce.
- Running status: a slow opacity pulse on the dot only.
- `prefers-reduced-motion: reduce`: all transforms become none, durations 1ms; state changes remain instant and complete.

## Voice

- Actions say what they do: **Start fixing bugs**, **Preview plan**, **Stop run**, **Open pull request**.
- Settings explain *why* a value is derived, in one line, instead of showing a field.
- Errors name the next step: "Jira credentials are not configured. Open Settings →".
- Never surface internal names (`sweep-started`, `SDD_*`) in the UI.

## Accessibility

- WCAG 2.2 AA; visible focus ring on every interactive element.
- Native `<dialog>` + `aria-labelledby`; Escape closes; focus returns to the trigger.
- `aria-live="polite"` announcer for run start, finish, and failures (not every log line).
- Terminal log is not a live region (too noisy); status is.
- Checkboxes have real `<input>` elements; rows are `<label>`s.
- Scroll containers are keyboard reachable and have `tabindex="0"` only when necessary.
- 200% zoom and 320px width are part of the test matrix.

## Anti-patterns

- No gradient text, no glass panels, no neon glow.
- No nested cards; no identical card grid.
- No tiny tracked eyebrow above every section.
- No pill for everything; stamps are rectangular and used for state only.
- No colour-only status; no icon-only destructive action without a label.
